#!/usr/bin/env bash
# cap scenario (T1-budget): the per-run count cap bounds how many issues ship. Seed 4
# independent issues, cap 3; exactly the three oldest ship and the fourth is left for the
# next night, named in the run.
#
# NOTE on the heading: in the real action the selection cap and the count BUDGET share one
# input (max-issues-per-run), so selection is capped to 3 BEFORE the between-issues count
# budget can trip - the count budget is redundant with the selection cap and is never the
# observable stopper here. The honest, reachable surface is the `capping to N` log line and
# a missing 4th PR, which is what we assert. (The `## Run stopped early (count budget)`
# heading only appears when a budget's count cap is lower than the selection cap, which no
# single input can produce.) See the Phase 0 PR description.

CAP_ISSUES=()

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  local i n body
  for i in 1 2 3 4; do
    body="$(printf 'set -e\nprintf "\\n<!-- CAP %s #%s -->\\n" >> README.md\n' "$RUN_TAG" "$i")"
    n="$(e2e_create_issue "[$RUN_TAG] cap issue $i" "$body" "for: ci-e2e")"
    CAP_ISSUES+=("$n")
  done
  e2e_wait_visible "for: ci-e2e" "${CAP_ISSUES[@]}" || return 1
  echo "seeded cap issues: ${CAP_ISSUES[*]}"
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=3"
}

scenario_assert() {
  local run_rc="$1" run_log="$2"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  # Oldest-first selection: the first three created ship, the fourth does not.
  e2e_assert_pr_for "${CAP_ISSUES[0]}" || rc=1
  e2e_assert_pr_for "${CAP_ISSUES[1]}" || rc=1
  e2e_assert_pr_for "${CAP_ISSUES[2]}" || rc=1
  e2e_assert_no_pr_for "${CAP_ISSUES[3]}" || rc=1
  # The run names the cap and that one issue is left for the next night.
  e2e_assert_log_contains "$run_log" "capping to 3 issue(s); 1 left for the next night" || rc=1
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
