#!/usr/bin/env bash
# paid-claude-api-key scenario (T5-anthropic-key): claude authenticated via ANTHROPIC_API_KEY
# ONLY (the metered API-credit auth path), NOT the subscription OAuth token. The auth path is
# what is under test, so the cheapest model (haiku) is the right choice. The assertion is on the
# AUTH PATH, not model quality: haiku sometimes "finishes but produces no changes", so fixowl
# opens no PR - a valid auth-success outcome that must PASS (a required-PR assertion would flake
# a now-blocking release on a weak-model no-op). One `for: ci-e2e` issue.
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
  # AUTH PATH, not model quality. Two hard signals prove the ANTHROPIC_API_KEY path works:
  #   1) fixowl processed the issue and the night exited cleanly, and
  #   2) the agent ran on the key with no auth/credential failure (401 / missing bearer) and no
  #      missing binary/deps.
  # A "no changes -> no PR" outcome (haiku declined the trivial edit) is a valid PASS.
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  paid_assert_no_agent_setup_errors "$run_log" || rc=1
  # Informational only: a ready PR is the happy path, but its absence must NOT fail this
  # auth-focused scenario, so it is logged, never asserted.
  e2e_load_prs
  if e2e_assert_pr_for "$CAK_ISSUE" 2>/dev/null; then
    echo "paid-claude-api-key: ready PR delivered (happy path)"
  else
    echo "paid-claude-api-key: no PR (haiku made no change); auth path verified, PASS"
  fi
  paid_record_claude_usage "paid-claude-api-key" "$summary_file"
  paid_record_result "paid-claude-api-key" "$rc"
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
