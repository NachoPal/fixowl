#!/usr/bin/env bash
# paid-claude-api-key scenario (T5-anthropic-key): claude authenticated via ANTHROPIC_API_KEY
# ONLY (the metered API-credit auth path), NOT the subscription OAuth token. The auth path is
# what is under test, so the cheapest model (haiku) is the right choice - a trivial README
# append is near-certain to land. One `for: ci-e2e` issue; assert a ready (non-draft) PR.
#
# Setting INPUT_AGENT-ENV=ANTHROPIC_API_KEY makes it the EXCLUSIVE container env allowlist
# (main.ts overrides the adapter default when agent-env is non-empty), so even if
# CLAUDE_CODE_OAUTH_TOKEN is present in the job env it never reaches the container - this is a
# clean test of the API-key path (and, per AGENTS.md, ANTHROPIC_API_KEY would win anyway).
# Billing resolves to api-credit (agentBilling(claude, [ANTHROPIC_API_KEY])).
#
# Sourced by run-scenarios.sh; defines the scenario_* contract. Paid helpers in paid-lib.sh.

source "$FIXOWL_DIR/scripts/e2e/paid-lib.sh"

CAK_ISSUE=""

scenario_seed() {
  CAK_ISSUE="$(paid_seed_single_issue "CLAUDE-KEY")" || return 1
  # Track in THIS shell (paid_seed_single_issue ran in a subshell, so its own tracking is lost).
  e2e_track_issue "$CAK_ISSUE"
  echo "seeded paid-claude-api-key issue: $CAK_ISSUE"
}

scenario_run_env() {
  echo "INPUT_AGENT=claude"
  echo "INPUT_AGENT-ENV=ANTHROPIC_API_KEY"
  echo "INPUT_DEFAULT-MODEL=haiku"
  echo "INPUT_DEFAULT-EFFORT=medium"
  echo "INPUT_LABEL-MODELS="
  paid_bounding_env 1
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  e2e_assert_pr_for "$CAK_ISSUE" || rc=1
  e2e_assert_pr_ready "$CAK_ISSUE" || rc=1
  paid_record_claude_usage "paid-claude-api-key" "$summary_file"
  paid_record_result "paid-claude-api-key" "$rc"
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
