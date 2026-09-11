#!/usr/bin/env bash
# layer2-off scenario (T2-layer2): the heuristic same-code conflict classifier (Layer 2) is
# OFF by default, so no classifier LLM call and no classify container ever run. Three
# independent issues all ship; the run log must contain neither the classifier banner nor a
# `-classify-` container name.

L2_ISSUES=()

scenario_seed() {
  e2e_label "for: ci-e2e" 0e8a16
  local i n body
  for i in 1 2 3; do
    body="$(printf 'set -e\nprintf "\\n<!-- LAYER2 %s #%s -->\\n" >> README.md\n' "$RUN_TAG" "$i")"
    n="$(e2e_create_issue "[$RUN_TAG] independent issue $i" "$body" "for: ci-e2e")"
    L2_ISSUES+=("$n")
  done
  e2e_wait_visible "for: ci-e2e" "${L2_ISSUES[@]}" || return 1
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=3"
  echo "INPUT_HEURISTIC-CONFLICT-ORDERING=false"
}

scenario_assert() {
  local run_rc="$1" run_log="$2"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  local n
  for n in "${L2_ISSUES[@]}"; do
    e2e_assert_pr_for "$n" || rc=1
  done
  # Layer 2 off: the classifier is never invoked.
  e2e_assert_log_absent "$run_log" "issues into dependency chains" || rc=1
  e2e_assert_log_absent "$run_log" "-classify-" || rc=1
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
