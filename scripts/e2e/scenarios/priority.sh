#!/usr/bin/env bash
# priority scenario (T5-priority): priority-label selection fills the cap highest-tier-first,
# overriding oldest-first, and Layer 1 still orders blocked_by edges within the selection.
#
# Fixtures (created oldest-first low -> high so oldest-first and priority-first disagree):
#   L  priority: low      (oldest)
#   M  priority: medium
#   H1 priority: high
#   H2 priority: high, blocked_by H1
# cap 2, priority-labels "high,medium,low". Priority fills the cap with the two highs; L and
# M are left out, and H2 stacks on H1 (prerequisites always win within the selection).
#
# NOTE: priority selection chooses WHICH issues fill the cap by tier; it is not
# prerequisite-aware (it never pulls a lower-tier prerequisite into a full cap). The design
# report's "low prerequisite of a high dependent, skip medium" outcome is therefore not
# reachable (a lower tier can never be taken while a higher tier is skipped); this fixture
# keeps the two selected issues in the same (high) tier so both genuinely ship and the
# blocked_by ordering is exercised. See the Phase 0 PR description.

PR_L=""
PR_M=""
PR_H1=""
PR_H2=""

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  e2e_label "priority: high" b60205
  e2e_label "priority: medium" fbca04
  e2e_label "priority: low" 0e8a16
  local body
  body="$(printf 'set -e\nprintf "\\n<!-- PRIO %s -->\\n" >> README.md\n' "$RUN_TAG")"
  PR_L="$(e2e_create_issue "[$RUN_TAG] low prio" "$body" "for: ci-e2e" "priority: low")"
  PR_M="$(e2e_create_issue "[$RUN_TAG] medium prio" "$body" "for: ci-e2e" "priority: medium")"
  PR_H1="$(e2e_create_issue "[$RUN_TAG] high prio one" "$body" "for: ci-e2e" "priority: high")"
  PR_H2="$(e2e_create_issue "[$RUN_TAG] high prio two (dep)" "$body" "for: ci-e2e" "priority: high")"
  e2e_add_blocked_by "$PR_H2" "$PR_H1"
  e2e_wait_visible "for: ci-e2e" "$PR_L" "$PR_M" "$PR_H1" "$PR_H2" || return 1
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=2"
  echo "INPUT_PRIORITY-LABELS=priority: high,priority: medium,priority: low"
  echo "INPUT_PRIORITY-INCLUDE-UNLABELED=false"
}

scenario_assert() {
  local run_rc="$1" run_log="$2"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  # The two highest-priority issues fill the cap, oldest L and M are left out.
  e2e_assert_pr_for "$PR_H1" || rc=1
  e2e_assert_pr_for "$PR_H2" || rc=1
  e2e_assert_no_pr_for "$PR_L" || rc=1
  e2e_assert_no_pr_for "$PR_M" || rc=1
  # blocked_by still wins within the selection: H2 stacks on H1.
  e2e_assert_stacks "$PR_H1" "$PR_H2" || rc=1
  e2e_assert_log_contains "$run_log" "by priority" || rc=1
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
