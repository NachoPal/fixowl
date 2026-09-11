#!/usr/bin/env bash
# Shared helpers for the free, zero-spend E2E scenario suite (scripts/e2e/run-scenarios.sh
# and scripts/e2e/scenarios/*.sh). Every scenario runs the real fixowl bundle with the
# `script` adapter against the persistent sandbox (NachoPal/fixowl-e2e-sandbox), so there
# is ZERO LLM spend but the full plumbing runs.
#
# This file is SOURCED, never executed. It defines helpers and does not set -e itself -
# the runner and each scenario manage their own shell options.
#
# Invariants honored here (see AGENTS.md "Real-call end-to-end tests"): nothing is ever
# merged; the agent (script body) never receives a GitHub token; fixtures are tagged with
# a unique RUN_TAG and the `for: ci-e2e` selector so a run only ever touches its own issues.
#
# Env expected by most helpers:
#   R           owner/repo of the sandbox (set from SANDBOX_REPO by the runner)
#   GH_TOKEN    the sandbox App installation token, used ONLY by fixture gh calls here -
#               never passed to the container/agent.

# --- fixture tracking -------------------------------------------------------------------
# Scenarios MAY register the issues they create in this array, but note the array is only a
# best-effort supplement: `e2e_cleanup_tracked` discovers a scenario's own issues from the
# sandbox by their RUN_TAG title marker instead, because `e2e_create_issue` is always called
# inside `$(...)` command substitution and any append it does runs in a subshell that never
# reaches the caller. A direct `e2e_track_issue <n>` in a scenario body (not through a command
# substitution) does reach here and is unioned into cleanup.
E2E_TRACKED_ISSUES=()

e2e_track_issue() {
  E2E_TRACKED_ISSUES+=("$1")
}

# --- label / issue creation -------------------------------------------------------------
# Idempotent label create. --force is safe to repeat and never fails the seed.
e2e_label() {
  local name="$1" color="${2:-ededed}"
  gh label create "$name" -R "$R" --color "$color" --force >/dev/null 2>&1 || true
}

# Create an issue; echo its number. Extra args are labels.
#   e2e_create_issue "<title>" "<body>" "label a" "label b" ...
e2e_create_issue() {
  local title="$1" body="$2"
  shift 2
  local args=(api "repos/$R/issues" -f "title=$title" -f "body=$body")
  local label
  for label in "$@"; do
    args+=(-f "labels[]=$label")
  done
  local number
  number="$(gh "${args[@]}" --jq .number)"
  e2e_track_issue "$number"
  echo "$number"
}

# Native blocked_by edge: mark <dependent> blocked_by <blocker>. The endpoint takes the
# blocker's numeric DATABASE id, not its issue number (see seed.sh).
e2e_add_blocked_by() {
  local dependent="$1" blocker="$2" blocker_id
  blocker_id="$(gh api "repos/$R/issues/$blocker" --jq .id)"
  gh api -X POST "repos/$R/issues/$dependent/dependencies/blocked_by" -F issue_id="$blocker_id" >/dev/null
}

# --- remote branch fixtures (no local git) ----------------------------------------------
# Create a branch on the sandbox with a single commit, authored exactly as asked, entirely
# through the GitHub git database API. No local checkout is touched, so this never races
# with the bundle's .git extraction. Echoes the new commit SHA.
#   e2e_create_branch <branch> <file> <content> <commit-subject> <author-name> <author-email> [<parent-ref>]
e2e_create_branch() {
  local branch="$1" file="$2" content="$3" subject="$4" author_name="$5" author_email="$6"
  local parent_ref="${7:-main}"
  local base_sha base_tree blob_sha tree_sha commit_sha

  base_sha="$(gh api "repos/$R/git/ref/heads/$parent_ref" --jq .object.sha)"
  base_tree="$(gh api "repos/$R/commits/$base_sha" --jq .commit.tree.sha)"
  blob_sha="$(jq -n --arg c "$content" '{content:$c, encoding:"utf-8"}' \
    | gh api -X POST "repos/$R/git/blobs" --input - --jq .sha)"
  tree_sha="$(jq -n --arg bt "$base_tree" --arg p "$file" --arg b "$blob_sha" \
    '{base_tree:$bt, tree:[{path:$p, mode:"100644", type:"blob", sha:$b}]}' \
    | gh api -X POST "repos/$R/git/trees" --input - --jq .sha)"
  commit_sha="$(jq -n --arg m "$subject" --arg t "$tree_sha" --arg p "$base_sha" \
    --arg an "$author_name" --arg ae "$author_email" \
    '{message:$m, tree:$t, parents:[$p], author:{name:$an, email:$ae}}' \
    | gh api -X POST "repos/$R/git/commits" --input - --jq .sha)"
  jq -n --arg r "refs/heads/$branch" --arg s "$commit_sha" '{ref:$r, sha:$s}' \
    | gh api -X POST "repos/$R/git/refs" --input - >/dev/null
  echo "$commit_sha"
}

# Current tip SHA of a remote branch (empty if it does not exist).
e2e_branch_tip() {
  gh api "repos/$R/git/ref/heads/$1" --jq .object.sha 2>/dev/null || true
}

# Open a real PR for an already-pushed branch. Echoes the PR number. Used to prove a
# branch WITH a PR is skipped (never reset).
e2e_open_pr() {
  local head="$1" base="${2:-main}" title="$3"
  jq -n --arg t "$title" --arg h "$head" --arg b "$base" \
    '{title:$t, head:$h, base:$b, body:"e2e fixture PR"}' \
    | gh api -X POST "repos/$R/pulls" --input - --jq .number
}

# --- selection-visibility wait ----------------------------------------------------------
# GitHub's label-filtered issue list is eventually consistent (see seed.sh). Block until
# every given issue number is visible to fixowl's exact selection query for <label>.
#   e2e_wait_visible "<label>" <num> [<num> ...]
e2e_wait_visible() {
  local label="$1"
  shift
  local wanted=("$@")
  local timeout="${SEED_WAIT_TIMEOUT_SECS:-60}" interval="${SEED_WAIT_INTERVAL_SECS:-3}"
  local deadline=$(($(date +%s) + timeout))
  local visible ok n
  while :; do
    visible="$(gh api -X GET "repos/$R/issues" \
      -f state=open -f "labels=$label" -f per_page=100 --paginate \
      --jq '.[] | select(.pull_request == null) | .number' 2>/dev/null | tr '\n' ' ')"
    ok=1
    for n in "${wanted[@]}"; do
      grep -qw "$n" <<<"$visible" || ok=0
    done
    if [ "$ok" = "1" ]; then
      echo "issues visible to the '$label' selection query: [$visible]"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "ERROR: issues [${wanted[*]}] not visible to '$label' query after ${timeout}s (last: [$visible])" >&2
      return 1
    fi
    sleep "$interval"
  done
}

# Block until an issue reaches a target state (OPEN|CLOSED). GitHub processes a merged
# closing-keyword PR's auto-close ASYNCHRONOUSLY, so a fixture that merges a "Fixes #N" PR and
# then needs the issue reopened must first wait for that close to land - otherwise the reopen
# races the pending close, no-ops (the issue is still open at that instant), and the close then
# leaves the issue closed (the triage-a seed race that failed run 34592034086). Bounded poll.
#   e2e_wait_issue_state <issue-number> <OPEN|CLOSED> [timeout-secs]
e2e_wait_issue_state() {
  local n="$1" want="$2"
  local timeout="${3:-${SEED_WAIT_TIMEOUT_SECS:-60}}" interval="${SEED_WAIT_INTERVAL_SECS:-3}"
  local deadline=$(($(date +%s) + timeout))
  local state
  while :; do
    state="$(gh issue view "$n" -R "$R" --json state --jq .state 2>/dev/null | tr '[:lower:]' '[:upper:]')"
    if [ "$state" = "$want" ]; then
      echo "issue #$n reached state $want"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "ERROR: issue #$n did not reach state $want after ${timeout}s (last: ${state:-unknown})" >&2
      return 1
    fi
    sleep "$interval"
  done
}

# --- cleanup ----------------------------------------------------------------------------
# Close one issue, then close every PR on an issue/<n>-* head branch and delete that branch.
# fixowl never merges, so closing PRs and deleting topic branches restores the sandbox to its
# clean baseline. Best-effort: a missing PR/branch is not an error.
#   _e2e_teardown_issue <issue-number>
_e2e_teardown_issue() {
  local n="$1" pr branch
  [ -n "$n" ] || return 0
  gh issue close -R "$R" "$n" >/dev/null 2>&1
  gh pr list -R "$R" --state all --limit 100 --json number,headRefName \
    | jq -r --arg p "issue/$n-" '.[] | select(.headRefName | startswith($p)) | "\(.number)\t\(.headRefName)"' \
    | while IFS=$'\t' read -r pr branch; do
        [ -n "$pr" ] && gh pr close -R "$R" "$pr" >/dev/null 2>&1
        [ -n "$branch" ] && gh api -X DELETE "repos/$R/git/refs/heads/$branch" >/dev/null 2>&1
      done
}

# Best-effort teardown of THIS scenario's fixtures plus any extra branch names it pushed
# directly. fixowl never merges, so closing PRs and deleting topic branches restores the
# sandbox to its clean baseline.
#
# The scenario's own issues are discovered from the sandbox by their unique RUN_TAG title
# marker ("[$RUN_TAG] ..."), NOT from an in-process array: `e2e_create_issue` is always
# called inside `$(...)` command substitution, so any array it appended to in that subshell
# is lost to the caller (this was the cause of the cross-scenario contamination in run
# 34582938659 - cleanup ran but found nothing, and every scenario's fixtures leaked into the
# shared `for: ci-e2e` selection of the next one). Discovery by RUN_TAG needs no cooperation
# from the scenario and is scoped exactly to its own issues. E2E_TRACKED_ISSUES is still
# unioned in for any issue a scenario tracked directly (e.g. baseline).
#
# The discovery label defaults to `for: ci-e2e` (byte-for-byte unchanged for every existing
# scenario); a scenario whose fixtures carry a different selector label (triage-a's dedicated
# `for: ci-e2e-triage`) sets E2E_CLEANUP_LABEL to it before calling so its own issues are
# still discovered and torn down.
#   e2e_cleanup_tracked [<extra-branch> ...]
e2e_cleanup_tracked() {
  local extra_branches=("$@")
  local n pr branch discovered
  # Issues whose title carries this scenario's RUN_TAG (open or closed). RUN_TAG is a fixed
  # set of [a-z0-9-] chars, so interpolating it into the jq filter is safe.
  discovered="$(gh api -X GET "repos/$R/issues" \
    -f state=all -f "labels=${E2E_CLEANUP_LABEL:-for: ci-e2e}" -f per_page=100 --paginate \
    --jq ".[] | select(.pull_request == null) | select(.title | startswith(\"[$RUN_TAG]\")) | .number" \
    2>/dev/null | tr '\n' ' ')"
  for n in $discovered "${E2E_TRACKED_ISSUES[@]}"; do
    [ -n "$n" ] || continue
    _e2e_teardown_issue "$n"
  done
  for branch in "${extra_branches[@]}"; do
    [ -n "$branch" ] || continue
    # Close any PR on this branch first, then delete the ref.
    gh pr list -R "$R" --state all --limit 100 --json number,headRefName \
      | jq -r --arg b "$branch" '.[] | select(.headRefName == $b) | .number' \
      | while read -r pr; do [ -n "$pr" ] && gh pr close -R "$R" "$pr" >/dev/null 2>&1; done
    gh api -X DELETE "repos/$R/git/refs/heads/$branch" >/dev/null 2>&1
  done
}

# Suite-start sweep: close any lingering OPEN free-suite fixture issue (title starts with
# "[free-", the RUN_TAG prefix every scenario uses) and delete its issue/<n>-* branch + PR,
# plus any stranded triage-a fixture branch (e2e-triage-fix-*). A scenario's own EXIT-trap
# cleanup normally leaves the sandbox clean, but a hard job cancellation (or a historical run
# predating the cleanup fix) can strand fixtures that would then contaminate the next run's
# selection. Running this once before the scenario loop makes the suite self-healing and
# deterministic.
#
# Scoped tightly so it only ever clears THIS suite's own stranded fixtures:
#   - Issues: the "[free-" title prefix under BOTH E2E selector labels - the shared
#     `for: ci-e2e` (the 11 scenarios) and the dedicated `for: ci-e2e-triage` (triage-a's
#     Layer-A fixtures). It never touches the sandbox's `for: agent` nightly issues.
#   - Branches: only refs under the `e2e-triage-fix-` prefix (triage-a's throwaway
#     closing-PR head branches, which a merged PR leaves undeletable-by-PR-close). These are
#     uniquely RUN_TAG-named and the current run's branch is created LATER, in triage-a's seed,
#     so deleting every e2e-triage-fix-* ref here only ever clears PRIOR runs' leftovers and
#     never a persistent branch, an issue/* topic branch, or anything else.
e2e_sweep_stale_fixtures() {
  local n stale label branch triage_branches
  for label in "for: ci-e2e" "for: ci-e2e-triage"; do
    stale="$(gh api -X GET "repos/$R/issues" \
      -f state=open -f "labels=$label" -f per_page=100 --paginate \
      --jq '.[] | select(.pull_request == null) | select(.title | startswith("[free-")) | .number' \
      2>/dev/null | tr '\n' ' ')"
    if [ -n "${stale// /}" ]; then
      echo "sweep: clearing stale '$label' fixtures: [$stale]"
      for n in $stale; do
        [ -n "$n" ] || continue
        _e2e_teardown_issue "$n"
      done
    fi
  done
  triage_branches="$(gh api -X GET "repos/$R/git/matching-refs/heads/e2e-triage-fix-" \
    --jq '.[].ref | sub("refs/heads/"; "")' 2>/dev/null | tr '\n' ' ')"
  if [ -n "${triage_branches// /}" ]; then
    echo "sweep: clearing stranded triage-a fixture branches: [$triage_branches]"
    for branch in $triage_branches; do
      [ -n "$branch" ] || continue
      gh api -X DELETE "repos/$R/git/refs/heads/$branch" >/dev/null 2>&1 || true
    done
  fi
  echo "sweep: done"
}

# --- PR / summary / log assertions ------------------------------------------------------
# Assertion helpers print a clear ASSERT FAILED line and return non-zero; the runner
# aggregates per-scenario pass/fail. They never call exit, so cleanup still runs.
E2E_PRS_JSON=""

e2e_load_prs() {
  E2E_PRS_JSON="$(gh pr list -R "$R" --state all --limit 100 \
    --json number,headRefName,baseRefName,isDraft,author)"
  echo "PRs in $R:"
  jq -r '.[] | "  #\(.number) head=\(.headRefName) base=\(.baseRefName) draft=\(.isDraft)"' <<<"$E2E_PRS_JSON"
}

e2e_fail() {
  echo "ASSERT FAILED: $1" >&2
  return 1
}

# A PR exists whose head branch starts with issue/<n>-
e2e_assert_pr_for() {
  jq -e --arg p "issue/$1-" 'any(.[]; .headRefName | startswith($p))' <<<"$E2E_PRS_JSON" >/dev/null \
    || e2e_fail "no PR on an issue/$1-* branch"
}

# No PR exists whose head branch starts with issue/<n>-
e2e_assert_no_pr_for() {
  if jq -e --arg p "issue/$1-" 'any(.[]; .headRefName | startswith($p))' <<<"$E2E_PRS_JSON" >/dev/null; then
    e2e_fail "a PR exists on an issue/$1-* branch but none was expected"
  fi
}

# A PR on issue/<n>-* is out of draft (CI gate went green / unverified-ready).
e2e_assert_pr_ready() {
  jq -e --arg p "issue/$1-" 'any(.[]; (.headRefName | startswith($p)) and (.isDraft == false))' \
    <<<"$E2E_PRS_JSON" >/dev/null || e2e_fail "PR on issue/$1-* is still a draft (CI never went green)"
}

# <dependent>'s PR base is <prerequisite>'s branch (Layer-1 stacking).
e2e_assert_stacks() {
  jq -e --arg a "issue/$1-" --arg b "issue/$2-" \
    'any(.[]; (.headRefName | startswith($b)) and (.baseRefName | startswith($a)))' \
    <<<"$E2E_PRS_JSON" >/dev/null || e2e_fail "issue $2's PR does not stack on issue $1's branch"
}

e2e_assert_summary_contains() {
  local file="$1" needle="$2"
  grep -qF -- "$needle" "$file" || e2e_fail "run summary missing expected text: $needle"
}

e2e_assert_summary_absent() {
  local file="$1" needle="$2"
  if grep -qF -- "$needle" "$file"; then
    e2e_fail "run summary unexpectedly contains: $needle"
  fi
}

e2e_assert_log_contains() {
  local file="$1" needle="$2"
  grep -qF -- "$needle" "$file" || e2e_fail "run log missing expected text: $needle"
}

e2e_assert_log_absent() {
  local file="$1" needle="$2"
  if grep -qF -- "$needle" "$file"; then
    e2e_fail "run log unexpectedly contains: $needle"
  fi
}
