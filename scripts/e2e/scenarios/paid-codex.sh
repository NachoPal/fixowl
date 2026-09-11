#!/usr/bin/env bash
# paid-codex scenario (T5-codex / T2-codex): the codex adapter end-to-end on an App-only GitHub
# credential and the OPENAI_API_KEY agent credential. Exercises `codex login --with-api-key`,
# the codex-ready sandbox image, and `codex exec` inside the hardened non-root container. One
# `for: ci-e2e` issue; assert a ready (non-draft) PR AND that the run log has no agent
# auth/setup failure (401 / missing bearer / Cannot find module).
#
# Model: gpt-5.4-mini - the model the sandbox already runs successfully today, proven reachable
# without organization verification. The night run does NOT validate the model against the
# catalog (only fixowl init/validate do), so this passes through; the separate live
# model-validation step (scripts/e2e/validate-models.mjs) checks it against the key's real
# /v1/models list so drift is caught explicitly.
#
# Sourced by run-scenarios.sh; defines the scenario_* contract. Paid helpers in paid-lib.sh.

source "$FIXOWL_DIR/scripts/e2e/paid-lib.sh"

CODEX_ISSUE=""

scenario_seed() {
  CODEX_ISSUE="$(paid_seed_single_issue "CODEX")" || return 1
  # Track in THIS shell (paid_seed_single_issue ran in a subshell, so its own tracking is lost).
  e2e_track_issue "$CODEX_ISSUE"
  echo "seeded paid-codex issue: $CODEX_ISSUE"
}

scenario_run_env() {
  echo "INPUT_AGENT=codex"
  echo "INPUT_AGENT-ENV=OPENAI_API_KEY"
  echo "INPUT_DEFAULT-MODEL=gpt-5.4-mini"
  echo "INPUT_LABEL-MODELS="
  paid_bounding_env 1
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  e2e_assert_pr_for "$CODEX_ISSUE" || rc=1
  e2e_assert_pr_ready "$CODEX_ISSUE" || rc=1
  paid_assert_no_agent_setup_errors "$run_log" || rc=1
  paid_record_codex_usage "paid-codex" "$summary_file" "$CODEX_ISSUE"
  paid_record_result "paid-codex" "$rc"
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
