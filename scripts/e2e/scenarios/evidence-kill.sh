#!/usr/bin/env bash
# evidence-kill scenario (T1-evidence): per-issue evidence is uploaded PROGRESSIVELY, so a
# finished issue's evidence survives a later cancellation. A ships quickly; B sleeps so it
# never finishes. The runner backgrounds the bundle, waits for A's "evidence uploaded as
# artifact" log line, then kills the process (the cancellation proxy). A's evidence artifact
# is in the fixowl run and B never opened a PR.
#
# REQUIRES the wrapper action: the bundle's @actions/artifact upload needs ACTIONS_RUNTIME_TOKEN,
# which is only present when this suite runs under .github/actions/e2e-run (a JS `uses:` step).
# The success log line is printed by main.ts ONLY on a real successful upload, so its presence
# is the primary proof; when FIXOWL_SELF_TOKEN is set we also confirm via the artifacts API.

EK_A=""
EK_B=""
EK_KILLED=0

scenario_seed() {
  if [ -z "${ACTIONS_RUNTIME_TOKEN:-}" ]; then
    echo "ASSERT FAILED: evidence-kill needs ACTIONS_RUNTIME_TOKEN - run the suite under the" >&2
    echo "  .github/actions/e2e-run wrapper action (a JS uses: step), not a bare 'run:' step." >&2
    echo "  (Locally, set SCENARIOS to a subset that excludes evidence-kill.)" >&2
    return 1
  fi
  e2e_label "for: ci-e2e" 0e8a16
  local body_a body_b
  body_a="$(printf 'set -e\nprintf "\\n<!-- EVIDENCE %s -->\\n" >> README.md\n' "$RUN_TAG")"
  body_b='sleep 600' # never finishes; killed mid-flight
  EK_A="$(e2e_create_issue "[$RUN_TAG] evidence issue A (ships)" "$body_a" "for: ci-e2e")"
  EK_B="$(e2e_create_issue "[$RUN_TAG] evidence issue B (killed)" "$body_b" "for: ci-e2e")"
  e2e_wait_visible "for: ci-e2e" "$EK_A" "$EK_B" || return 1
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=2"
}

# Background the bundle, wait for A's evidence-uploaded line, then kill (cancellation proxy).
scenario_run_bundle() {
  local summary_file="$1" run_log="$2"
  shift 2
  env \
    FIXOWL_UNSAFE_SCRIPT_AGENT=1 \
    INPUT_AGENT=script \
    "INPUT_LABELS-ANY=for: ci-e2e" \
    "INPUT_ISSUE-TIMEOUT-MINUTES=15" \
    "INPUT_MAX-CI-TRIES=2" \
    "INPUT_CI-TIMEOUT-MINUTES=15" \
    "INPUT_HEURISTIC-CONFLICT-ORDERING=false" \
    "GITHUB_STEP_SUMMARY=$summary_file" \
    "$@" \
    node "$DIST" >"$run_log" 2>&1 &
  local pid=$!
  local marker="evidence uploaded as artifact \"fixowl-evidence-issue-$EK_A\""
  local waited=0 timeout=600
  while kill -0 "$pid" 2>/dev/null; do
    if grep -qF "$marker" "$run_log"; then
      echo "saw A's evidence upload; killing the night to simulate a cancellation"
      EK_KILLED=1
      kill -TERM "$pid" 2>/dev/null
      sleep 2
      kill -KILL "$pid" 2>/dev/null
      break
    fi
    if [ "$waited" -ge "$timeout" ]; then
      echo "timed out after ${timeout}s waiting for A's evidence-upload line" >&2
      kill -KILL "$pid" 2>/dev/null
      break
    fi
    sleep 3
    waited=$((waited + 3))
  done
  wait "$pid" 2>/dev/null
  cat "$run_log"
  return 0 # a killed night has no meaningful exit code; assert on evidence + B below
}

scenario_assert() {
  local run_rc="$1" run_log="$2"
  local rc=0
  [ "$EK_KILLED" = "1" ] \
    || { echo "ASSERT FAILED: never observed A's evidence upload before the kill" >&2; rc=1; }
  e2e_assert_log_contains "$run_log" "evidence uploaded as artifact \"fixowl-evidence-issue-$EK_A\"" || rc=1
  e2e_load_prs
  e2e_assert_pr_for "$EK_A" || rc=1
  e2e_assert_no_pr_for "$EK_B" || rc=1
  # Best-effort cross-check against the fixowl run's own artifacts. Non-fatal: artifact
  # listing can lag right after the upload, and the success log line above (printed by
  # main.ts only on a real successful @actions/artifact upload) is the authoritative proof.
  if [ -n "${FIXOWL_SELF_TOKEN:-}" ] && [ -n "${FIXOWL_RUN_ID:-}" ]; then
    local self_repo names
    self_repo="${FIXOWL_SELF_REPO:-NachoPal/fixowl}"
    names="$(GH_TOKEN="$FIXOWL_SELF_TOKEN" gh api \
      "repos/$self_repo/actions/runs/$FIXOWL_RUN_ID/artifacts" --jq '.artifacts[].name' 2>/dev/null | tr '\n' ' ')"
    if grep -q "fixowl-evidence-issue-$EK_A" <<<"$names"; then
      echo "confirmed fixowl-evidence-issue-$EK_A in the fixowl run's artifacts"
    else
      echo "NOTE: artifacts API did not (yet) list fixowl-evidence-issue-$EK_A (got: $names); " \
        "relying on the upload-success log line above" >&2
    fi
  fi
  return $rc
}

scenario_cleanup() {
  # Kill any leftover container from the killed night (best-effort), then tear down fixtures.
  docker ps -q --filter "name=fixowl-" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
  e2e_cleanup_tracked
}
