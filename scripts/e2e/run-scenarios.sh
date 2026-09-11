#!/usr/bin/env bash
# Free, zero-spend E2E scenario runner. Loops over scripts/e2e/scenarios/*.sh and runs the
# real fixowl bundle (the `script` adapter, no LLM spend) against the persistent sandbox
# once per scenario, asserting the exact renderSummary heading / PR surface each scenario
# targets. One job, one sequential loop - NOT a matrix - so the shared sandbox concurrency
# group is never raced (matrix legs would cancel each other).
#
# It is invoked from the .github/actions/e2e-run wrapper action (a JS `uses:` step) so that
# ACTIONS_RUNTIME_TOKEN is present in this process tree and the bundle's progressive
# evidence upload lands in the fixowl run (the evidence-kill scenario depends on that).
# Running this directly from a `run:` step still works for every scenario except the
# evidence artifact assertion, which needs that token.
#
# Env in:
#   SANDBOX_REPO        owner/repo of the sandbox (required)
#   GH_TOKEN            sandbox App installation token, for fixture gh calls only (required)
#   FIXOWL_APP_*        the App runtime trio the bundle authenticates with (required)
#   SANDBOX_WORKSPACE   path to the sandbox checkout (default: $GITHUB_WORKSPACE/sandbox)
#   SCENARIOS           optional space-separated subset of scenario names (default: all)
#   RUNNER_TEMP         scratch dir (required by the bundle; defaults to a mktemp dir)
set -uo pipefail

: "${SANDBOX_REPO:?set SANDBOX_REPO=owner/repo}"
: "${GH_TOKEN:?set GH_TOKEN to the sandbox App installation token}"

FIXOWL_DIR="$PWD"
DIST="$FIXOWL_DIR/dist/action/index.js"
[ -f "$DIST" ] || { echo "bundle not built: $DIST missing (run pnpm build)" >&2; exit 1; }

# Retarget the bundle at the sandbox. A process MAY set GITHUB_* in its own env (the runner
# only ignores step-level `env:` overrides of them), and every node child inherits these.
SANDBOX_WS="${SANDBOX_WORKSPACE:-${GITHUB_WORKSPACE:-$FIXOWL_DIR}/sandbox}"
[ -d "$SANDBOX_WS" ] || { echo "sandbox checkout not found at $SANDBOX_WS" >&2; exit 1; }
export GITHUB_REPOSITORY="$SANDBOX_REPO"
export GITHUB_WORKSPACE="$SANDBOX_WS"
export GITHUB_EVENT_NAME=workflow_dispatch # keep the scheduled-slot budget guard inert
export RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"

R="$SANDBOX_REPO"
# shellcheck source=scripts/e2e/lib.sh
source "$FIXOWL_DIR/scripts/e2e/lib.sh"

GH_RUN_ID="${GITHUB_RUN_ID:-local}"
GH_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
JOB_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
SCEN_DIR="$(mktemp -d)"

SCENARIO_DIR="$FIXOWL_DIR/scripts/e2e/scenarios"
# Default order: baseline first (warms the docker image cache), evidence-kill last (it runs
# the bundle in the background and kills it).
DEFAULT_ORDER="baseline red-green cap second-run orphan-and-foreign agent-error layer2-off priority triage-a triage-b uid-probe evidence-kill"
SCENARIOS="${SCENARIOS:-$DEFAULT_ORDER}"

# Self-heal before the loop: clear any stale free-suite fixtures left by a hard-cancelled
# prior run so they cannot contaminate this run's shared `for: ci-e2e` selection. Best-effort;
# a scenario's own EXIT-trap cleanup keeps the sandbox clean during the run.
e2e_sweep_stale_fixtures

PASSED=()
FAILED=()

run_one_scenario() {
  local name="$1"
  local file="$SCENARIO_DIR/$name.sh"
  [ -f "$file" ] || { echo "unknown scenario: $name ($file missing)" >&2; return 1; }
  (
    set +e
    # Each scenario defines scenario_seed / scenario_run_env / scenario_assert / scenario_cleanup.
    # shellcheck source=/dev/null
    source "$file"
    # RUN_TAG_PREFIX defaults to "free" so the zero-spend suite is byte-for-byte unchanged; the
    # paid tier sets RUN_TAG_PREFIX=paid so its sandbox fixtures are not mislabeled "free-".
    # (Additive, default-preserving - kept trivial for the concurrent harness-repair rebase.)
    export RUN_TAG="${RUN_TAG_PREFIX:-free}-${GH_RUN_ID}-${GH_RUN_ATTEMPT}-${name}"
    local summary_file="$SCEN_DIR/$name.summary.md"
    local run_log="$SCEN_DIR/$name.run.log"
    : > "$summary_file"
    : > "$run_log"
    echo "=================================================================="
    echo ">>> scenario: $name  (RUN_TAG=$RUN_TAG)"
    echo "=================================================================="

    # Always tear this scenario's fixtures down, even on a mid-scenario failure.
    trap 'scenario_cleanup || true' EXIT

    if ! scenario_seed; then
      echo "SEED FAILED for $name" >&2
      return 1
    fi

    # Collect scenario-specific inputs for the bundle run.
    local -a scen_env=()
    local line
    while IFS= read -r line; do
      [ -n "$line" ] && scen_env+=("$line")
    done < <(scenario_run_env)

    # Run the real bundle. Base inputs first, scenario inputs last (they win). The App trio
    # and GITHUB_* retargeting are already exported into the environment.
    SUMMARY_FILE="$summary_file" RUN_LOG="$run_log" \
      scenario_run_bundle "$summary_file" "$run_log" "${scen_env[@]}"
    local run_rc=$?
    echo "bundle exit: $run_rc"

    local result
    if scenario_assert "$run_rc" "$run_log" "$summary_file"; then
      echo "SCENARIO PASS: $name"
      result=pass
    else
      echo "SCENARIO FAIL: $name" >&2
      result=fail
    fi

    {
      echo "## scenario: ${name} - ${result}"
      echo ""
      echo "<details><summary>run summary</summary>"
      echo ""
      cat "$summary_file"
      echo ""
      echo "</details>"
      echo ""
    } >> "$JOB_SUMMARY"

    [ "$result" = "pass" ]
  )
}

# Default bundle invocation shared by scenarios that do not override it. Scenarios needing
# different process control (e.g. evidence-kill's background+kill) define their own
# scenario_run_bundle before sourcing completes; the default is re-established per scenario.
default_run_bundle() {
  local summary_file="$1" run_log="$2"
  shift 2
  env \
    FIXOWL_UNSAFE_SCRIPT_AGENT=1 \
    INPUT_AGENT=script \
    "INPUT_LABELS-ANY=for: ci-e2e" \
    "INPUT_MAX-ISSUES-PER-RUN=3" \
    "INPUT_ISSUE-TIMEOUT-MINUTES=15" \
    "INPUT_MAX-CI-TRIES=2" \
    "INPUT_CI-TIMEOUT-MINUTES=15" \
    "INPUT_HEURISTIC-CONFLICT-ORDERING=false" \
    "GITHUB_STEP_SUMMARY=$summary_file" \
    "$@" \
    node "$DIST" 2>&1 | tee "$run_log"
  return "${PIPESTATUS[0]}"
}

for name in $SCENARIOS; do
  # Re-establish the default bundle runner for each scenario; a scenario that needs custom
  # process control overrides scenario_run_bundle inside its own (sourced) file.
  scenario_run_bundle() { default_run_bundle "$@"; }
  if run_one_scenario "$name"; then
    PASSED+=("$name")
  else
    FAILED+=("$name")
  fi
done

echo ""
echo "=================================================================="
echo "scenario results: ${#PASSED[@]} passed, ${#FAILED[@]} failed"
echo "  passed: ${PASSED[*]:-none}"
echo "  failed: ${FAILED[*]:-none}"
echo "=================================================================="

{
  echo "## free E2E scenario suite"
  echo ""
  echo "- passed (${#PASSED[@]}): ${PASSED[*]:-none}"
  echo "- failed (${#FAILED[@]}): ${FAILED[*]:-none}"
  echo ""
} >> "$JOB_SUMMARY"

[ "${#FAILED[@]}" -eq 0 ]
