#!/usr/bin/env bash
# second-run scenario (T1-standdown, skip half): running the night twice on the same
# fixtures is idempotent. The first run ships the issue (branch + PR); the second run finds
# the branch already attempted and stands down honestly - its summary reports the issue
# under `## Skipped (branch already exists)`, NOT the false "No open issues matched".
#
# (The scheduled-slot `Stood down:` half of T1-standdown depends on listing the sandbox's
# own workflow runs with the E2E run id, which do not exist there, so it stays unit-level.)

SR_ISSUE=""

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  local body
  body="$(printf 'set -e\nprintf "\\n<!-- SECONDRUN %s -->\\n" >> README.md\n' "$RUN_TAG")"
  SR_ISSUE="$(e2e_create_issue "[$RUN_TAG] idempotent second run" "$body" "for: ci-e2e")"
  e2e_wait_visible "for: ci-e2e" "$SR_ISSUE" || return 1
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=1"
}

# Run the bundle twice against the same fixture. Only the SECOND run's summary/log are
# asserted on (handed in by the runner); the first run's go to scratch files.
scenario_run_bundle() {
  local summary_file="$1" run_log="$2"
  shift 2
  # The bundle writes the run summary through @actions/core, which requires the file named by
  # GITHUB_STEP_SUMMARY to already EXIST (it only appends). The runner pre-creates the second
  # run's summary/log, but the first run's are our own scratch files, so create them here or
  # the first run dies with "Unable to access summary file" and exits 1 before the second runs.
  local first_summary="$SCEN_DIR/second-run.first.summary.md"
  local first_log="$SCEN_DIR/second-run.first.run.log"
  : > "$first_summary"
  : > "$first_log"
  default_run_bundle "$first_summary" "$first_log" "$@"
  local rc1=$?
  echo "first run exit: $rc1"
  [ "$rc1" = "0" ] || return "$rc1"
  default_run_bundle "$summary_file" "$run_log" "$@"
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: second run exited $run_rc" >&2; rc=1; }
  # The first run's PR is still there; the second run touched nothing.
  e2e_load_prs
  e2e_assert_pr_for "$SR_ISSUE" || rc=1
  e2e_assert_summary_contains "$summary_file" "## Skipped (branch already exists)" || rc=1
  e2e_assert_summary_absent "$summary_file" "No open issues matched" || rc=1
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
