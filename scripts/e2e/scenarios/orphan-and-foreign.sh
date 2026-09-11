#!/usr/bin/env bash
# orphan-and-foreign scenario (T2-orphan + T3-ownership): the PR-less-branch reset is
# ownership-gated.
#   X: a fixowl-OWNED orphan branch (subject `fix #X:`, no PR) -> reset and retried -> a new
#      PR lands on issue/X-* (T2-orphan).
#   Z: a FOREIGN branch (human author, unrelated subject, no PR) -> preserved, issue skipped,
#      branch tip unchanged - fixowl never deletes a branch it did not create (T3-ownership).

OF_X=""
OF_Z=""
OF_Z_BRANCH=""
OF_Z_TIP_BEFORE=""

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  local body_x body_z
  body_x="$(printf 'set -e\nprintf "\\n<!-- ORPHAN %s -->\\n" >> README.md\n' "$RUN_TAG")"
  body_z="$(printf 'set -e\nprintf "\\n<!-- FOREIGN %s -->\\n" >> README.md\n' "$RUN_TAG")"
  OF_X="$(e2e_create_issue "[$RUN_TAG] orphaned fixowl branch" "$body_x" "for: ci-e2e")"
  OF_Z="$(e2e_create_issue "[$RUN_TAG] foreign branch preserved" "$body_z" "for: ci-e2e")"
  OF_Z_BRANCH="issue/$OF_Z-foreign"

  # X: fixowl-owned orphan branch (recognized by the `fix #<n>:` subject trailer), no PR.
  e2e_create_branch "issue/$OF_X-orphan" ".e2e-orphan-$RUN_TAG" "orphan $RUN_TAG" \
    "fix #$OF_X: orphaned interrupted work" "someone" "someone@example.com" >/dev/null

  # Z: foreign branch - a human author and an unrelated subject, no PR. Must be preserved.
  OF_Z_TIP_BEFORE="$(e2e_create_branch "$OF_Z_BRANCH" ".e2e-foreign-$RUN_TAG" "foreign $RUN_TAG" \
    "chore: experiment from a teammate" "A Human" "human@example.com")"

  e2e_wait_visible "for: ci-e2e" "$OF_X" "$OF_Z" || return 1
  echo "seeded orphan X=#$OF_X, foreign Z=#$OF_Z (branch $OF_Z_BRANCH @ $OF_Z_TIP_BEFORE)"
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=2"
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  # X: orphan reset+retried -> a PR now exists on issue/X-*.
  e2e_assert_pr_for "$OF_X" || rc=1
  e2e_assert_log_contains "$run_log" "orphaned" || rc=1
  # Z: foreign branch preserved - no PR, tip unchanged, reported skipped with the ownership warning.
  e2e_assert_no_pr_for "$OF_Z" || rc=1
  local tip_after
  tip_after="$(e2e_branch_tip "$OF_Z_BRANCH")"
  [ "$tip_after" = "$OF_Z_TIP_BEFORE" ] \
    || { echo "ASSERT FAILED: foreign branch tip changed ($OF_Z_TIP_BEFORE -> $tip_after)" >&2; rc=1; }
  e2e_assert_summary_contains "$summary_file" "## Skipped (branch already exists)" || rc=1
  e2e_assert_log_contains "$run_log" "is not fixowl's" || rc=1
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked "$OF_Z_BRANCH" "issue/$OF_X-orphan"
}
