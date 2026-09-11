#!/usr/bin/env bash
# Helpers for the PAID E2E tier (scripts/e2e/scenarios/paid-*.sh and claude-oauth.sh).
#
# The paid tier reuses the free suite's scenario contract and runner byte-for-byte
# (scripts/e2e/run-scenarios.sh, scripts/e2e/lib.sh): every paid scenario defines the same
# scenario_seed / scenario_run_env / scenario_assert / scenario_cleanup functions, is selected
# via SCENARIOS=..., and runs the real fixowl bundle against the shared sandbox. The ONLY
# difference is the agent: a real claude/codex call (bounded, cheap) instead of the zero-spend
# `script` adapter, chosen entirely through INPUT_AGENT / INPUT_AGENT-ENV in scenario_run_env.
#
# This file is intentionally SEPARATE from lib.sh so the paid tier adds no churn to the shared
# harness the free suite (and a concurrent harness-repair ship) depends on: paid scenarios
# `source` both lib.sh's helpers (already loaded by the runner) and this file. It defines only
# additive helpers and reads two optional env paths the e2e-paid job sets:
#   PAID_RESULTS_FILE   append "<scenario>\t<PASS|FAIL>"        (per-scenario outcome, for the artifact)
#   PAID_USAGE_FILE     append "<scenario>\t<total-tokens|note>" (measured token usage, for the summary)
# Both are optional: when unset (e.g. a local single-scenario run) the helpers are no-ops.
#
# Invariants honored (see AGENTS.md): nothing is ever merged; the agent never receives a GitHub
# token (only the allowlisted agent credential enters the container); fixtures carry the
# `for: ci-e2e` selector and a unique RUN_TAG so a run only ever touches its own issues - a
# paid scenario NEVER uses a real `for: agent` label.

# Bounding inputs every paid scenario applies (design report 5.1): cap the issue count to the
# fixture count, keep per-issue and whole-run wall-clock tight, and bound CI retries. Emitted by
# each scenario's scenario_run_env; the count cap is passed per scenario (fixture-count-specific).
#   paid_bounding_env <max-issues>
paid_bounding_env() {
  local max_issues="$1"
  echo "INPUT_MAX-ISSUES-PER-RUN=$max_issues"
  echo "INPUT_ISSUE-TIMEOUT-MINUTES=10"
  echo "INPUT_MAX-CI-TRIES=2"
  echo "INPUT_RUN-BUDGET-MINUTES=15"
  echo "INPUT_CI-TIMEOUT-MINUTES=10"
  # Never a real for: agent label - the paid tier only ever selects its own fixtures.
  echo "INPUT_LABELS-ANY=for: ci-e2e"
}

# Natural-language single-issue seed for the real agent. Echoes ONLY the issue number on stdout
# (all diagnostics go to stderr) so the caller can capture it with `n="$(paid_seed_single_issue ...)"`
# The body is a tiny, near-certain README append so a cheap turn (haiku / a mini codex model)
# lands a clean diff; assertions are on delivery, never on content (like seed.sh's paid bodies).
#
# NOTE: this runs inside the caller's command substitution (a subshell), so it does NOT track the
# issue - a subshell's E2E_TRACKED_ISSUES never reaches the parent. The caller MUST call
# `e2e_track_issue "$n"` itself in its own shell so cleanup tears the fixture down.
#   paid_seed_single_issue <marker>   (marker distinguishes concurrent scenarios in README)
paid_seed_single_issue() {
  local marker="$1" n
  e2e_label "for: ci-e2e" 0e8a16 >&2
  local body="Append a single new line \`<!-- $marker $RUN_TAG -->\` to the very end of README.md. Change nothing else."
  n="$(e2e_create_issue "[$RUN_TAG] $marker append to README" "$body" "for: ci-e2e")"
  e2e_wait_visible "for: ci-e2e" "$n" >&2 || return 1
  echo "$n"
}

# Record a scenario's pass/fail outcome for the artifact. rc 0 => PASS, else FAIL.
#   paid_record_result <scenario> <rc>
paid_record_result() {
  local scenario="$1" rc="$2" result
  [ "$rc" = "0" ] && result=PASS || result=FAIL
  [ -n "${PAID_RESULTS_FILE:-}" ] && printf '%s\t%s\n' "$scenario" "$result" >> "$PAID_RESULTS_FILE"
  return 0
}

# Measure codex token usage from the per-issue EVIDENCE agent logs (via the product's own parser)
# and record it to PAID_USAGE_FILE plus the per-scenario summary file (so it also lands in the job
# summary). codex --json output rides the AGENT's stdout, which fixowl writes to the evidence log
# (<RUNNER_TEMP>/fixowl-evidence/issue-<n>/agent-attempt-*.log), not the action's own stdout.
#   paid_record_codex_usage <scenario> <summary-file> <issue> [<issue> ...]
paid_record_codex_usage() {
  local scenario="$1" summary_file="$2"
  shift 2
  local evidence_root="${RUNNER_TEMP:-}/fixowl-evidence"
  local -a logs=()
  local issue f
  for issue in "$@"; do
    for f in "$evidence_root/issue-$issue/"agent-attempt-*.log; do
      [ -f "$f" ] && logs+=("$f")
    done
  done
  local json total note
  if [ "${#logs[@]}" -eq 0 ]; then
    json="null"
  else
    json="$(node "$FIXOWL_DIR/scripts/e2e/paid-usage.mjs" "${logs[@]}" 2>/dev/null || echo null)"
  fi
  if [ "$json" = "null" ] || [ -z "$json" ]; then
    note="not measured (no codex usage found in the evidence agent logs)"
    total="n/a"
  else
    total="$(jq -r '.totalTokens // "n/a"' <<<"$json" 2>/dev/null || echo "n/a")"
    note="total ${total} tokens (input $(jq -r '.inputTokens // 0' <<<"$json"), output $(jq -r '.outputTokens // 0' <<<"$json"))"
  fi
  [ -n "${PAID_USAGE_FILE:-}" ] && printf '%s\t%s\n' "$scenario" "$total" >> "$PAID_USAGE_FILE"
  {
    echo ""
    echo "**measured token usage (codex):** $note"
  } >> "$summary_file"
  echo "measured token usage for $scenario: $note"
  return 0
}

# Record that claude's in-band token usage is not measured (design report / #143: claude fix-mode
# stdout is plain text, so the product does not pass --output-format json and the in-band meter
# abstains). Honest placeholder so the summary is complete rather than silently missing claude.
#   paid_record_claude_usage <scenario> <summary-file>
paid_record_claude_usage() {
  local scenario="$1" summary_file="$2"
  local note="not measured in-band (claude fix mode is parsed as plain text; #143 tracks a json-safe meter)"
  [ -n "${PAID_USAGE_FILE:-}" ] && printf '%s\t%s\n' "$scenario" "$note" >> "$PAID_USAGE_FILE"
  {
    echo ""
    echo "**measured token usage (claude):** $note"
  } >> "$summary_file"
  return 0
}

# Assert the captured run log has no credential/auth/module failure (design report T5-codex).
# Returns non-zero (and prints ASSERT FAILED) if any appears.
#   paid_assert_no_agent_setup_errors <run-log>
paid_assert_no_agent_setup_errors() {
  local run_log="$1" rc=0
  # Match 401 only in an HTTP/auth context ("401 Unauthorized", "HTTP 401", "status code 401",
  # "error: 401"), never a bare 401 that could appear inside a SHA or token count.
  if grep -qiE '(401[^0-9]{0,2}unauthorized|(status|code|http|error)[^0-9]{0,12}401)' "$run_log"; then
    e2e_fail "run log contains an HTTP 401 (agent auth failure)" || rc=1
  fi
  if grep -qiF "missing bearer" "$run_log"; then
    e2e_fail "run log contains 'missing bearer' (agent auth failure)" || rc=1
  fi
  if grep -qiF "Cannot find module" "$run_log"; then
    e2e_fail "run log contains 'Cannot find module' (agent binary/deps not installed)" || rc=1
  fi
  return $rc
}
