#!/usr/bin/env bash
# triage-a scenario (T5-triage, Layer A): the deterministic pre-gate skips an issue on
# GitHub's own high-precision signals BEFORE any agent runs - so no agent is spent, no PR
# is opened, the issue is commented once + labeled `fixowl:triaged`, and it is reported
# under `## Triaged out (not worked)` (main.ts applyTriageSkip / renderSummary). Two signals:
#   Fixture 1 (already-fixed): an issue closed by a MERGED closing-keyword PR ("Fixes #N")
#     and then reopened - the `closedByPullRequestsReferences` merged link that
#     reduceTriageNode reads (packages/action/src/github-api.ts).
#   Fixture 2 (duplicate): an issue carrying the `duplicate` label (planTriage reads the
#     label directly, no marked-as-duplicate event needed).
#
# FULLY-AUTOMATED per run (the captain's choice): the harness creates + merges + reopens +
# duplicate-labels + runs + asserts-skip + tears down its own fixtures every run, RUN_TAG
# scoped, with NO manual sandbox prep. This SUPERSEDES the design report's manual
# persistent-fixture approach (report section 3 T5-triage / section 4.4 item 3 / decision 5)
# - there are no hand-made fixtures to maintain. Layer A skips before any agent runs, so this
# is a FREE scenario (zero LLM spend), validated by the free suite.
#
# ROBUSTNESS (issue: triage-a flaked on run 34592034086 while the other 11 scenarios were
# stable). Two properties keep it deterministic against real, possibly-polluted sandbox state:
#   1. A DEDICATED selector label `for: ci-e2e-triage`, distinct from the shared `for: ci-e2e`
#      the other scenarios select on. Layer A's `duplicate`/closing-PR signals are label-
#      orthogonal, so the gate still fires; the dedicated label fully isolates triage-a's
#      selection from every other scenario's fixtures in both directions. Cleanup discovers
#      this scenario's issues by RUN_TAG under that label (E2E_CLEANUP_LABEL), and the
#      suite-start sweep clears stranded `for: ci-e2e-triage` "[free-" issues and
#      `e2e-triage-fix-*` branches too (lib.sh).
#   2. The reopen sequenced AFTER the merge's async auto-close (see the note at the reopen).
#      The prior version reopened immediately, raced the pending close, and left the issue
#      closed - so it never became visible to the OPEN-issue selection (the run 34592034086
#      seed failure). e2e_wait_issue_state closes that race.
# Fresh per-run fixtures + fixowl excluding `fixowl:triaged` from selection + the sweep make
# the scenario tolerant of any residual leftover (a stranded branch or a previously-triaged
# issue) without failing.
#
# Because the already-fixed signal only exists once a closing-keyword PR is MERGED into the
# default branch, this scenario merges a throwaway PR in the sandbox. See the prominent
# HARNESS-ONLY note at the merge below: that is the TEST HARNESS building a disposable
# fixture, NOT the fixowl product merging. The product's hard "never merge" guarantee is
# unchanged - no packages/*/src path merges (no-merge.test.ts enforces that), the merge code
# lives only here in scripts/e2e, and the sandbox is disposable.

TA_FIXED=""      # fixture 1 issue number (already-fixed)
TA_DUP=""        # fixture 2 issue number (duplicate)
TA_FIX_BRANCH="" # throwaway head branch of the closing PR (deleted in cleanup)
TA_FIX_FILE=""   # file the closing PR adds to main (removed from main in cleanup)

scenario_seed() {
  e2e_label "for: ci-e2e-triage" 0e8a16
  e2e_label "duplicate" cfd3d7

  # A real edit body: if Layer A ever FAILED to skip, the `script` agent would run this and a
  # PR would land on issue/<n>-*, so the no-PR assertion below fails loudly rather than falsely.
  local edit_body
  edit_body="$(printf 'set -e\nprintf "\\n<!-- TRIAGE-A %s should never run -->\\n" >> README.md\n' "$RUN_TAG")"

  TA_FIX_BRANCH="e2e-triage-fix-$RUN_TAG"
  TA_FIX_FILE=".triage-fixed-$RUN_TAG"
  # Idempotence: a residual same-named branch from a hard-cancelled prior run would make the
  # ref-create below fail. RUN_TAG is unique per run so a collision is nearly impossible, but
  # delete any leftover first so a re-run is always clean. Best-effort.
  gh api -X DELETE "repos/$R/git/refs/heads/$TA_FIX_BRANCH" >/dev/null 2>&1 || true

  # --- Fixture 1: already-fixed (closed by a merged closing-keyword PR, then reopened) ------
  TA_FIXED="$(e2e_create_issue "[$RUN_TAG] already fixed by a merged PR" "$edit_body" "for: ci-e2e-triage")"
  e2e_create_branch "$TA_FIX_BRANCH" "$TA_FIX_FILE" "already-fixed fixture $RUN_TAG" \
    "chore: land the already-fixed triage fixture" "A Human" "human@example.com" >/dev/null

  # The PR BODY carries a closing keyword so merging it formally closes the issue and records
  # the closing-keyword reference GitHub reports as `merged`.
  local pr_num
  pr_num="$(jq -n --arg t "[$RUN_TAG] closing PR for the already-fixed fixture" \
    --arg h "$TA_FIX_BRANCH" --arg b "Fixes #$TA_FIXED" \
    '{title:$t, head:$h, base:"main", body:$b}' \
    | gh api -X POST "repos/$R/pulls" --input - --jq .number)"

  # === HARNESS-ONLY SANDBOX-FIXTURE MERGE ==================================================
  # This is the TEST HARNESS building a throwaway Layer-A fixture in a DISPOSABLE sandbox -
  # it is NOT the fixowl product merging, and the product's hard "never merge" invariant is
  # untouched: no packages/*/src code path merges (no-merge.test.ts scans only packages/*/src),
  # and this merge exists ONLY here in scripts/e2e. Merging into the DEFAULT branch (main) is
  # exactly what makes GitHub record the "Fixes #N" reference as `merged` and auto-close the
  # issue - the already-fixed signal reduceTriageNode reads. The E2E App credential (GH_TOKEN,
  # which already opens PRs and pushes for the other scenarios, so it holds Pull requests +
  # Contents: write) performs the merge; the sandbox `main` is unprotected, so a merge commit
  # is accepted. If the App genuinely cannot merge, fail the seed LOUDLY with the exact reason
  # rather than working around it.
  local merge_out merge_rc
  merge_out="$(gh api -X PUT "repos/$R/pulls/$pr_num/merge" \
    -f merge_method=merge -f "commit_title=harness fixture merge $RUN_TAG" 2>&1)"
  merge_rc=$?
  if [ "$merge_rc" != "0" ]; then
    echo "ASSERT FAILED (triage-a precondition): the E2E App could not merge fixture PR #$pr_num." >&2
    echo "  gh output: $merge_out" >&2
    echo "  The already-fixed fixture needs a merged closing-keyword PR. A permission error here" >&2
    echo "  means the E2E App is missing 'Pull requests: write' (or 'Contents: write')." >&2
    return 1
  fi
  # ========================================================================================

  # The merged "Fixes #N" keyword auto-closes the issue, but ASYNCHRONOUSLY. Reopening before
  # that async close lands leaves the issue closed once the close finally fires (the run
  # 34592034086 seed race: the reopen saw "already open", no-op'd, the close then closed it,
  # and the issue never became visible to the OPEN-issue selection). So WAIT for GitHub to
  # record the close, THEN reopen, THEN confirm it is open again. The merged closing reference
  # (the already-fixed signal) persists across the reopen.
  e2e_wait_issue_state "$TA_FIXED" CLOSED || {
    echo "ASSERT FAILED (triage-a precondition): merged PR #$pr_num did not auto-close issue #$TA_FIXED" >&2
    return 1
  }
  gh issue reopen -R "$R" "$TA_FIXED" >/dev/null
  e2e_wait_issue_state "$TA_FIXED" OPEN || {
    echo "ASSERT FAILED (triage-a precondition): could not reopen issue #$TA_FIXED after the fixture merge" >&2
    return 1
  }

  # --- Fixture 2: duplicate (carries the `duplicate` label) --------------------------------
  TA_DUP="$(e2e_create_issue "[$RUN_TAG] duplicate issue" "$edit_body" "for: ci-e2e-triage" "duplicate")"

  e2e_wait_visible "for: ci-e2e-triage" "$TA_FIXED" "$TA_DUP" || return 1
  echo "seeded already-fixed #$TA_FIXED (merged PR #$pr_num, reopened) + duplicate #$TA_DUP"
}

scenario_run_env() {
  echo "INPUT_MAX-ISSUES-PER-RUN=2"
  # Select on the dedicated triage label so this scenario is fully isolated from the shared
  # `for: ci-e2e` pool the other scenarios use.
  echo "INPUT_LABELS-ANY=for: ci-e2e-triage"
  # Layer A gate on; both default to true, set explicitly so the scenario is self-describing.
  echo "INPUT_SKIP-ALREADY-FIXED=true"
  echo "INPUT_SKIP-DUPLICATES=true"
}

scenario_assert() {
  local run_rc="$1" run_log="$2" summary_file="$3"
  local rc=0
  [ "$run_rc" = "0" ] || { echo "ASSERT FAILED: bundle exited $run_rc" >&2; rc=1; }
  e2e_load_prs

  # Neither fixture was worked: no PR on either issue/<n>-* branch (proves no agent ran).
  e2e_assert_no_pr_for "$TA_FIXED" || rc=1
  e2e_assert_no_pr_for "$TA_DUP" || rc=1

  # Both are reported under the Triaged-out heading, each with the right reason.
  e2e_assert_summary_contains "$summary_file" "## Triaged out (not worked)" || rc=1
  e2e_assert_summary_contains "$summary_file" "already fixed by a merged PR" || rc=1
  e2e_assert_summary_contains "$summary_file" "duplicate" || rc=1

  # The log shows Layer A skipped each for the right category, before any agent (no PR opened).
  e2e_assert_log_contains "$run_log" "issue #$TA_FIXED: triaged (already-fixed); no PR opened" || rc=1
  e2e_assert_log_contains "$run_log" "issue #$TA_DUP: triaged (duplicate); no PR opened" || rc=1

  # Both carry the cross-run, comment-once fixowl:triaged marker.
  local labels_fixed labels_dup
  labels_fixed="$(gh issue view "$TA_FIXED" -R "$R" --json labels --jq '.labels[].name' | tr '\n' ' ')"
  grep -q "fixowl:triaged" <<<"$labels_fixed" \
    || { echo "ASSERT FAILED: issue #$TA_FIXED missing fixowl:triaged (got: $labels_fixed)" >&2; rc=1; }
  labels_dup="$(gh issue view "$TA_DUP" -R "$R" --json labels --jq '.labels[].name' | tr '\n' ' ')"
  grep -q "fixowl:triaged" <<<"$labels_dup" \
    || { echo "ASSERT FAILED: issue #$TA_DUP missing fixowl:triaged (got: $labels_dup)" >&2; rc=1; }

  return $rc
}

scenario_cleanup() {
  # Remove the fixture file the harness merge added to the sandbox default branch, so main is
  # left byte-for-byte clean (a normal delete commit, never a force-update of main). Best-effort.
  if [ -n "$TA_FIX_FILE" ]; then
    local sha
    sha="$(gh api "repos/$R/contents/$TA_FIX_FILE?ref=main" --jq .sha 2>/dev/null || true)"
    if [ -n "$sha" ]; then
      gh api -X DELETE "repos/$R/contents/$TA_FIX_FILE" \
        -f "message=chore: remove triage-a fixture $RUN_TAG" -f "sha=$sha" -f branch=main >/dev/null 2>&1 || true
    fi
  fi
  # Close both issues + tear down any issue/<n>-* branch/PR, and delete the throwaway closing
  # branch (a merged PR cannot be closed - that step no-ops harmlessly; the ref is deleted).
  # E2E_CLEANUP_LABEL points discovery at this scenario's dedicated selector label.
  E2E_CLEANUP_LABEL="for: ci-e2e-triage" e2e_cleanup_tracked "$TA_FIX_BRANCH"
}
