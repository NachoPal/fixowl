#!/usr/bin/env bash
# Best-effort teardown, run under `if: always()` so a mid-run failure strands
# nothing. Scoped to THIS run's fixtures (issues A and B and their issue/<n>-*
# branches/PRs) so it is safe even if another sandbox run overlaps. fixowl never
# merges, so nothing here is ever merged - closing PRs and deleting the topic
# branches returns the persistent sandbox to its clean baseline.
#
# Env in: SANDBOX_REPO, A, B (may be empty if seeding failed), GH_TOKEN
set +e   # never let teardown fail the job

: "${SANDBOX_REPO:?set SANDBOX_REPO=owner/repo}"
R="$SANDBOX_REPO"

for n in "${A:-}" "${B:-}"; do
  [ -n "$n" ] || continue
  echo "closing issue #$n and its issue/$n-* PR(s)/branch(es)"
  gh issue close -R "$R" "$n" >/dev/null 2>&1

  # Close any PR whose head is this issue's topic branch, then delete the branch.
  gh pr list -R "$R" --state all --limit 100 --json number,headRefName \
    | jq -r --arg p "issue/$n-" '.[] | select(.headRefName | startswith($p)) | "\(.number)\t\(.headRefName)"' \
    | while IFS=$'\t' read -r pr branch; do
        [ -n "$pr" ] && gh pr close -R "$R" "$pr" >/dev/null 2>&1
        [ -n "$branch" ] && gh api -X DELETE "repos/$R/git/refs/heads/$branch" >/dev/null 2>&1
      done
done

echo "cleanup done (best-effort)"
exit 0
