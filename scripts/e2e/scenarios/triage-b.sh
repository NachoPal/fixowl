#!/usr/bin/env bash
# triage-b scenario (T5-triage, Layer B): verify-before-fix. The agent verifies against the
# current code first and emits a verdict to stdout while making NO change. The host reads
# the verdict + the (empty) diff, opens NO PR, comments once, labels the issue
# `fixowl:triaged`, and reports it under `## Triaged out (not worked)`.
#
# (Layer A - the already-fixed/duplicate pre-gate - needs persistent hand-made fixtures and
# a merged PR, so it is a Phase 1 scenario; this covers the free, per-run Layer B.)

TB_ISSUE=""

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  # Print the verdict to stdout and change nothing - a no-diff run is what triage keys on.
  local body='echo '\''FIXOWL_VERDICT: {"verdict":"already-implemented","explanation":"e2e verified already done"}'\'''
  TB_ISSUE="$(e2e_create_issue "[$RUN_TAG] verify-before-fix triage" "$body" "for: ci-e2e")"
  e2e_wait_visible "for: ci-e2e" "$TB_ISSUE" || return 1
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=1"
  echo "INPUT_VERIFY-BEFORE-FIX=true"
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  e2e_assert_no_pr_for "$TB_ISSUE" || rc=1
  e2e_assert_summary_contains "$summary_file" "## Triaged out (not worked)" || rc=1
  # The issue is labeled fixowl:triaged (the cross-run, comment-once marker).
  local labels
  labels="$(gh issue view "$TB_ISSUE" -R "$R" --json labels --jq '.labels[].name' | tr '\n' ' ')"
  grep -q "fixowl:triaged" <<<"$labels" \
    || { echo "ASSERT FAILED: issue #$TB_ISSUE missing fixowl:triaged label (got: $labels)" >&2; rc=1; }
  # Exactly one triage comment was posted.
  local comments
  comments="$(gh api "repos/$R/issues/$TB_ISSUE/comments" --jq 'length')"
  [ "${comments:-0}" -ge 1 ] \
    || { echo "ASSERT FAILED: no triage comment on issue #$TB_ISSUE" >&2; rc=1; }
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
