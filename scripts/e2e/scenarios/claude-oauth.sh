#!/usr/bin/env bash
# claude-oauth paid scenario (kept AS-IS from the original e2e-paid job): one real claude
# sonnet/medium night on the CLAUDE_CODE_OAUTH_TOKEN (subscription) credential, over the exact
# baseline fixtures (two `for: ci-e2e` issues joined by one native blocked_by edge). It reuses
# seed.sh / assert.sh / cleanup.sh BYTE-FOR-BYTE (like the free baseline scenario) so the two
# tiers can never drift, then asserts the same delivery surface: A and B both ship, B stacks on
# A, both PRs go CI-green (out of draft). Covers T1-stack + the CI-gate half of T1-gate on a real
# agent. $0 marginal spend: it consumes the subscription's rolling usage window (see report 5.1).
#
# Sourced by run-scenarios.sh; defines the scenario_* contract. Paid helpers in paid-lib.sh.

source "$FIXOWL_DIR/scripts/e2e/paid-lib.sh"

CLAUDE_OAUTH_A=""
CLAUDE_OAUTH_B=""

scenario_seed() {
  local out
  out="$(mktemp)"
  # seed.sh writes A=/B= to GITHUB_OUTPUT; point it at a temp file and parse them back. E2E_MODE=paid
  # gives the two issues natural-language bodies for the real agent.
  GITHUB_OUTPUT="$out" E2E_MODE=paid bash "$FIXOWL_DIR/scripts/e2e/seed.sh" || return 1
  CLAUDE_OAUTH_A="$(grep '^A=' "$out" | cut -d= -f2)"
  CLAUDE_OAUTH_B="$(grep '^B=' "$out" | cut -d= -f2)"
  rm -f "$out"
  [ -n "$CLAUDE_OAUTH_A" ] && [ -n "$CLAUDE_OAUTH_B" ] || return 1
  e2e_track_issue "$CLAUDE_OAUTH_A"
  e2e_track_issue "$CLAUDE_OAUTH_B"
}

scenario_run_env() {
  echo "INPUT_AGENT=claude"
  echo "INPUT_AGENT-ENV=CLAUDE_CODE_OAUTH_TOKEN"
  echo "INPUT_DEFAULT-MODEL=sonnet"
  echo "INPUT_DEFAULT-EFFORT=medium"
  echo "INPUT_LABEL-MODELS=" # empty => every issue (incl. effort: high B) falls back to sonnet/medium
  paid_bounding_env 3       # two fixtures; keep the historical cap of 3
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  A="$CLAUDE_OAUTH_A" B="$CLAUDE_OAUTH_B" bash "$FIXOWL_DIR/scripts/e2e/assert.sh" || rc=1
  paid_record_claude_usage "claude-oauth" "$summary_file"
  paid_record_result "claude-oauth" "$rc"
  return $rc
}

scenario_cleanup() {
  A="$CLAUDE_OAUTH_A" B="$CLAUDE_OAUTH_B" bash "$FIXOWL_DIR/scripts/e2e/cleanup.sh"
}
