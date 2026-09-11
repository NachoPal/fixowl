#!/usr/bin/env bash
# baseline scenario: the original free E2E, reusing seed.sh / assert.sh / cleanup.sh
# BYTE-FOR-BYTE so the paid tier (which still calls those scripts directly) can never drift
# from what the free suite exercises. Two `for: ci-e2e` issues joined by one native
# blocked_by edge: B stacks on A, both ship CI-green. Covers T1-stack and the fallback-gate
# half of T1-gate.
#
# Sourced by run-scenarios.sh; defines the scenario_* contract.

BASELINE_A=""
BASELINE_B=""

scenario_seed() {
  local out
  out="$(mktemp)"
  # seed.sh writes A=/B= to GITHUB_OUTPUT; point it at a temp file and parse them back.
  GITHUB_OUTPUT="$out" E2E_MODE=free bash "$FIXOWL_DIR/scripts/e2e/seed.sh" || return 1
  BASELINE_A="$(grep '^A=' "$out" | cut -d= -f2)"
  BASELINE_B="$(grep '^B=' "$out" | cut -d= -f2)"
  rm -f "$out"
  [ -n "$BASELINE_A" ] && [ -n "$BASELINE_B" ] || return 1
  e2e_track_issue "$BASELINE_A"
  e2e_track_issue "$BASELINE_B"
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=3"
}

scenario_assert() {
  local run_rc="$1"
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; return 1; }
  A="$BASELINE_A" B="$BASELINE_B" bash "$FIXOWL_DIR/scripts/e2e/assert.sh"
}

scenario_cleanup() {
  A="$BASELINE_A" B="$BASELINE_B" bash "$FIXOWL_DIR/scripts/e2e/cleanup.sh"
}
