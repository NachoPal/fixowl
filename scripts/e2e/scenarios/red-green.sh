#!/usr/bin/env bash
# red-green scenario (T1-gate): the CI-gated fix loop turns a draft into ready only after a
# real red check goes green on retry. The script body toggles a `.ci-fail` marker file: the
# first attempt creates it (sandbox CI `test ! -f .ci-fail` goes RED), the CI-feedback retry
# removes it (CI goes GREEN), the PR flips to ready. Proves the loop retries on a real red
# and never reports a false green.
#
# DEPENDS ON A SANDBOX CHANGE: NachoPal/fixowl-e2e-sandbox's .github/workflows/ci.yml must
# gate on the marker (`test ! -f .ci-fail`) instead of the current `echo ok`. If it does
# not, this scenario FAILS LOUDLY in seed with the exact change needed - it never passes
# falsely.

RG_ISSUE=""

scenario_seed() {
  # Guard: the sandbox ci.yml must actually fail when .ci-fail is present, or the red leg is
  # a no-op and the whole scenario is meaningless. Fail loudly with the exact change needed.
  local ci_yml
  ci_yml="$(gh api "repos/$R/contents/.github/workflows/ci.yml" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true)"
  if ! grep -q '\.ci-fail' <<<"$ci_yml"; then
    echo "ASSERT FAILED (red-green precondition): the sandbox ci.yml does not gate on '.ci-fail'." >&2
    echo "  Required sandbox change in NachoPal/fixowl-e2e-sandbox .github/workflows/ci.yml:" >&2
    echo "    replace the check step 'run: echo ok' with 'run: test ! -f .ci-fail'" >&2
    echo "  (the baseline stays green because no fixture creates that file)." >&2
    return 1
  fi

  e2e_label "for: ci-e2e" 0e8a16
  local body
  body="$(printf 'set -e\nif [ -f .ci-fail ]; then rm -f .ci-fail; else : > .ci-fail; fi\nprintf "\\n<!-- REDGREEN %s -->\\n" >> README.md\n' "$RUN_TAG")"
  RG_ISSUE="$(e2e_create_issue "[$RUN_TAG] red-then-green CI gate" "$body" "for: ci-e2e")"
  e2e_wait_visible "for: ci-e2e" "$RG_ISSUE" || return 1
  echo "seeded red-green issue #$RG_ISSUE"
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=1"
  echo "INPUT_MAX-CI-TRIES=2" # attempt 1 red, attempt 2 green
}

scenario_assert() {
  local run_rc="$1" run_log="$2"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs
  e2e_assert_pr_for "$RG_ISSUE" || rc=1
  e2e_assert_pr_ready "$RG_ISSUE" || rc=1
  # The loop must have seen a real red on attempt 1 and retried (not a first-try green).
  e2e_assert_log_contains "$run_log" "is red (attempt 1/2)" || rc=1
  # No false green: the green PR must be reported green, never "unverified".
  e2e_assert_log_contains "$run_log" "required checks green" || rc=1
  e2e_assert_log_absent "$run_log" "CI unverified" || rc=1
  return $rc
}

scenario_cleanup() {
  e2e_cleanup_tracked
}
