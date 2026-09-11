#!/usr/bin/env bash
# agent-error scenario (T3-error): a real agent failure is surfaced honestly, with the
# captured error text, not a bare exit code. The failing issue's body exits non-zero with a
# chosen stderr message; a second, passing issue runs alongside so the night is NOT a total
# wipeout (a wipeout fails the job by design). The summary must row the failure as
# `agent-failed (... boom ...)`.

AE_FAIL=""
AE_PASS=""

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  local fail_body pass_body
  fail_body='echo "boom: simulated provider outage" >&2; exit 7'
  pass_body="$(printf 'set -e\nprintf "\\n<!-- AGENTOK %s -->\\n" >> README.md\n' "$RUN_TAG")"
  AE_FAIL="$(e2e_create_issue "[$RUN_TAG] agent error surfaced" "$fail_body" "for: ci-e2e")"
  AE_PASS="$(e2e_create_issue "[$RUN_TAG] agent ok alongside" "$pass_body" "for: ci-e2e")"
  e2e_wait_visible "for: ci-e2e" "$AE_FAIL" "$AE_PASS" || return 1
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=2"
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  # Not a total wipeout (one issue shipped), so the job must be green.
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc (expected 0; not a wipeout)" >&2; rc=1; }
  e2e_load_prs
  e2e_assert_pr_for "$AE_PASS" || rc=1
  e2e_assert_no_pr_for "$AE_FAIL" || rc=1
  # The failure is surfaced with its captured error text, not a bare exit code.
  e2e_assert_summary_contains "$summary_file" "agent-failed" || rc=1
  e2e_assert_summary_contains "$summary_file" "boom" || rc=1
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
