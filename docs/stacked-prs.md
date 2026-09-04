# Stacked PRs (dependent issues)

fixowl stacks a dependent issue's PR on its prerequisite's branch: issue B
branches off issue A's branch, and B's PR targets A's branch instead of the
default branch. The diff of B's PR then shows only B's changes, and B
structurally cannot reach the default branch before A.

Each stacked PR carries a banner: `Stacked on #<parent> - merge that first.`

## Two layers decide the stacking

1. **Native prerequisites (authoritative).** Before anything else, fixowl reads
   each selected issue's GitHub `blocked-by` edges (the ones `/issue` writes with
   `--blocked-by`, or that you add by hand). If B is blocked by A and A is also
   shipping tonight, B stacks on A and is ordered after it. If A is **not** in
   tonight's shippable set - not selected, capped out, cross-repo, or it failed
   to ship - B is **deferred**: no PR is attempted, and the reason is logged and
   listed under "Deferred" in the night summary. A closed blocker counts as
   satisfied. A dependency cycle defers the whole cycle. Unlike a same-code
   chain (below), a deferred dependent is never rebased onto the default branch:
   a real prerequisite that didn't land means the work genuinely cannot proceed.
2. **Same-code grouping (heuristic).** Over the non-deferred issues, fixowl then
   predicts which ones touch overlapping code and stacks those into chains to
   avoid merge conflicts. Prerequisites always win: this pass may reorder or
   split its groups to respect a `blocked-by` edge, and a prerequisite forces
   stacking even if the heuristic called two issues independent.

The rest of this doc applies to any stack, however it was formed.

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
