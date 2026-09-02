# Stacked PRs (dependent issues)

When classification predicts two issues touch overlapping code, fixowl fixes
them as a chain: issue B branches off issue A's branch, and B's PR targets
A's branch instead of the default branch. The diff of B's PR then shows only
B's changes, and B structurally cannot reach the default branch before A.

Each stacked PR carries a banner: `Stacked on #<parent> - merge that first.`

## The happy path

1. Review and merge the parent PR (A) into the default branch.
2. Delete A's branch (the merge button offers it).
3. GitHub automatically retargets B's PR onto the default branch.
4. Review and merge B. The chain unwinds naturally, one PR at a time.

Validate this behavior once per GitHub-plan/repo-settings combination before
trusting long chains (milestone M5 does exactly that): auto-retargeting is
GitHub behavior, not fixowl behavior.

## When the parent is rejected (closed unmerged)

Closing A unmerged and deleting its branch pollutes B: B's diff still contains
A's commits, now targeting the default branch. Do not try to salvage B.

Runbook:

1. Close B's PR too.
2. Delete both `issue/<a>-*` and `issue/<b>-*` branches.
3. Re-label or edit the surviving issue so the next night reattempts it
   cleanly (deleting the branch is what re-arms fixowl for that issue).

## Retry semantics (applies to all fixowl PRs)

The remote branch `issue/<n>-*` is the single source of truth:

- branch exists + open PR: in review, fixowl skips the issue
- branch merged: done (`fix #<n>:` in the commit closes the issue)
- branch exists + PR closed unmerged: deliberately abandoned, never retried
- to retry an issue: delete its branch; next run picks it up again
