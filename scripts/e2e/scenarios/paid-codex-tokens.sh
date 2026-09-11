#!/usr/bin/env bash
# paid-codex-tokens scenario (T5-tokenbudget): the total-token budget stops the night. codex is
# the only in-band-metered agent (agent-spend.ts::parseCodexUsage sums `codex exec --json`
# turn.completed usage), so this is the one path that can exercise the `total_token_budget` axis
# for real. Two independent `for: ci-e2e` issues are seeded with INPUT_TOTAL-TOKEN-BUDGET=1: the
# first issue ships, its measured spend (far more than 1 token) is folded into the accumulator,
# and the between-issues gate trips before the second issue starts.
#
# Assert exactly one PR (the first, oldest issue) and the `## Run stopped early (tokens budget)`
# summary heading; the second issue must have no PR.
#
# Model gpt-5.4-mini (as paid-codex). Sourced by run-scenarios.sh; paid helpers in paid-lib.sh.

source "$FIXOWL_DIR/scripts/e2e/paid-lib.sh"

CTOK_ISSUES=()

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  local i n body
  for i in 1 2; do
    body="Append a single new line \`<!-- CODEX-TOK$i $RUN_TAG -->\` to the very end of README.md. Change nothing else."
    n="$(e2e_create_issue "[$RUN_TAG] codex token-budget issue $i" "$body" "for: ci-e2e")"
    # e2e_create_issue tracked $n in its own subshell (lost); track in THIS shell for cleanup.
    e2e_track_issue "$n"
    CTOK_ISSUES+=("$n")
  done
  e2e_wait_visible "for: ci-e2e" "${CTOK_ISSUES[@]}" || return 1
  echo "seeded paid-codex-tokens issues: ${CTOK_ISSUES[*]}"
}

scenario_run_env() {
  echo "INPUT_AGENT=codex"
  echo "INPUT_AGENT-ENV=OPENAI_API_KEY"
  echo "INPUT_DEFAULT-MODEL=gpt-5.4-mini"
  echo "INPUT_LABEL-MODELS="
  echo "INPUT_TOTAL-TOKEN-BUDGET=1"
  paid_bounding_env 2 # two fixtures; the token budget - not the count cap - is the intended stopper
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  # Oldest-first selection: the first issue ships; the budget trips before the second starts.
  e2e_assert_pr_for "${CTOK_ISSUES[0]}" || rc=1
  e2e_assert_no_pr_for "${CTOK_ISSUES[1]}" || rc=1
  e2e_assert_summary_contains "$summary_file" "## Run stopped early (tokens budget)" || rc=1
  paid_record_codex_usage "paid-codex-tokens" "$summary_file" "${CTOK_ISSUES[@]}"
  paid_record_result "paid-codex-tokens" "$rc"
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
