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

   **In-flight prerequisite exception.** There is one case where A is not
   shipping tonight yet B still proceeds: A was **skipped by idempotency**
   because its `issue/<a>-*` branch is already in flight from a prior night. When
   that branch still has a **live** PR (open and unmerged), B stacks directly on
   A's existing branch - B's base and PR target become that branch, and B's PR is
   marked stacked on A's open PR - instead of re-running A. The gate is PR
   *liveness*, not branch existence (a merged branch often lingers on the
   remote): if A's PR is already **merged** it counts as satisfied and B bases
   off the default branch as normal; if A's PR is **closed unmerged** (abandoned)
   or A has no PR at all, B is disregarded-as-a-base and **deferred** as above -
   fixowl never stacks on abandoned work. This applies to native `blocked-by`
   edges only; the same-code heuristic below never stacks on a skipped branch
   across nights. A dependent blocked by several distinct in-flight bases, or by
   an in-flight base mixed with a same-night prerequisite, cannot be linearized
   and is deferred conservatively.
2. **Same-code grouping (heuristic, opt-in - off by default).** Over the
   non-deferred issues, fixowl can predict which ones touch overlapping code and
   stack those into chains to avoid merge conflicts. This layer is **disabled by
   default**; enable it with `heuristic_conflict_ordering: true` in your config
   (`defaults:` block or a per-repo entry). When on, prerequisites always win:
   this pass may reorder or split its groups to respect a `blocked-by` edge, and
   a prerequisite forces stacking even if the heuristic called two issues
   independent. When off, the classifier LLM call is skipped entirely and every
   non-deferred issue is independent, branched from the default branch - only
   Layer 1 native `blocked-by` edges cause any stacking.

   **Why default-off.** fixowl never merges (a hard invariant), so it never
   restacks what it stacks: any human edit to a base PR, or an out-of-order or
   partial merge, leaves the stacked children stale and hands you a manual
   restack - for a stack that was never *required* (these issues do not depend on
   each other). Independent PRs are more robust for piecemeal review: each is
   self-contained against the default branch, reviewable in isolation, and
   mergeable in any order, with a bounded, predictable merge conflict resolved at
   merge time. And the classifier is a paid LLM guess with real cost and latency
   and its own parse-failure fallback; when the guess is wrong it either invents a
   spurious stack or misses the overlap, so it only pays off when correct *and*
   you merge the whole stack promptly and in order. Native `blocked-by` ordering
   (Layer 1, above) is unaffected and always-on in both modes.

![How fixowl orders one example night. The night's selected issues (#12, #15, #18, #21, #23, #40) flow through two layers of pure planning. Layer 1 (prereq-planner.ts) reads native GitHub blocked-by edges, which are authoritative: #18 is blocked-by #15 and both ship tonight, so #15 is ordered first and #18 stacks under it; #21 is blocked-by #7 which is not in tonight's set, so #21 is deferred with no PR and its reason is logged in the night summary; #12, #23 and #40 have no edges and pass through. Layer 2 (classify.ts) is a same-file conflict heuristic over the survivors: it groups #12 and #23 because they touch the same files and predicts #15, #18 and #40 are independent. The merge (merge-graph.ts) overlays Layer 1 onto Layer 2 under "prerequisites always win": chain 1 is #12 then #23, chain 2 is #15 then #18 because the blocked-by edge forces the stack even though the heuristic split them, chain 3 is #40 alone, and #21 stays deferred. Finally the main.ts stacking loop turns each chain into stacked PRs: within a chain each PR targets the previous issue's branch (PR #23 targets issue/12, PR #18 targets issue/15) and the first PR of every chain targets the default branch main. One PR per issue; fixowl never merges.](../assets/issue-ordering.svg)

*The two-layer "double ordering": Layer 1 (`blocked-by`, authoritative) defers
what cannot ship and orders the rest; Layer 2 groups same-file issues; the two
merge into chains under "prerequisites always win", and each chain's PRs stack on
the previous branch. Numbers are illustrative. The behavior lives in
`packages/action/src/{prereq-planner,classify,merge-graph,main}.ts` and is
summarized in [AGENTS.md](../AGENTS.md) under "Night planning".*

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
