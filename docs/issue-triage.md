# Pre-work issue triage

fixowl picks up every OPEN issue that matches the pickup-label rule. Before it
spends an agent run on one, a two-layer triage gate skips issues that are already
fixed, duplicates, or no longer applicable - leaving one explanatory comment and
reporting the skip in the run summary. fixowl never opens a PR for a triaged-out
issue, and never opens an empty PR.

Both layers are **on by default** and **free**. There is no cross-run state store:
GitHub is the durable memory (the issue-to-PR link, duplicate markers, and the
`fixowl:triaged` label all live on GitHub and are read fresh each night).

## Layer A - the deterministic pre-gate (`skip_already_fixed`, `skip_duplicates`)

Runs after the branch-idempotency filter, before the `max_issues_per_run` cap, so
an obvious skip never wastes a nightly slot. One aliased, read-only GraphQL
round-trip over the whole candidate set (the `getIssueDependencies` technique)
reads each issue's own cross-reference graph - it is **not** a scan of past PRs,
and it costs one rate-limit point regardless of the candidate count.

It skips only on GitHub's own high-precision signals:

- **Already fixed** (`skip_already_fixed`): a **merged PR formally linked by a
  closing keyword** - `closedByPullRequestsReferences`, or a `CrossReferencedEvent`
  with `willCloseTarget: true` whose source PR is merged **in this repo**.
- **Duplicate** (`skip_duplicates`): a `MarkedAsDuplicateEvent` whose mark a later
  unmark did not undo, or the `duplicate` label.

A **bare** merged-PR cross-reference (a merged PR that merely mentions the issue
with no closing keyword) is deliberately **not** skipped here - it is ambiguous
(a merged PR often references an issue it does not fix), so it is left to Layer B.
See `planTriage` / `reduceTriageNode` and their tests.

## Layer B - the agent as ground truth (`verify_before_fix`)

For every issue that passes Layer A, the fix prompt is prepended with a
verify-first instruction (`VERIFY_FIRST_INSTRUCTION`, first pass only): the agent
checks the **current** code before changing anything and classifies the issue as
`already-implemented`, `partial`, `not-implemented`, or `not-applicable`, then
prints a verdict to stdout:

```
FIXOWL_VERDICT: {"verdict":"already-implemented","explanation":"..."}
```

**The agent never touches GitHub** - it has no token (the coding-agent invariant).
It only writes the verdict (to stdout, never a workspace file - a file would count
as a change and defeat the no-diff check, `hasChangesAgainst`). fixowl on the host
reads the verdict (`parseVerdict`) and the diff, then does every side effect with
its own App token:

- **No diff** -> open **no** PR. Leave a comment (`createIssueComment`, already
  wired) and stamp the `fixowl:triaged` label (`addLabels`, the one new edge),
  and report it. The comment wording comes from the verdict; a missing/garbled
  verdict falls back to a conservative "produced no change" comment, so a parse
  miss is always safe.
- **A diff** -> the normal commit / push / draft-PR / CI-gated loop.

The verdict is advisory: the no-PR decision is driven by the diff, so verdict
parsing is never safety-critical.

## The `fixowl:triaged` marker label (comment once)

On any skip (either layer) fixowl applies the `fixowl:triaged` label. Issue
selection excludes any issue carrying it, so a triaged-out issue is never
re-scanned, re-run, re-commented, or re-reported on later nights. Remove the label
to have fixowl reconsider the issue. The comment/label writes are best-effort - a
failure is logged and the skip is still recorded in the summary. This label is
fixowl's only cross-run triage state, and it lives on GitHub.

## Reporting

Triaged-out issues appear under `## Triaged out (not worked)` in the run summary,
disjoint from the branch-exists `## Skipped` section (Layer A runs on the
already-branch-filtered set; Layer B skips got past the gate). See
`NightSummary.triaged` and `renderSummary`.

## Config

Per-repo and under `defaults` in the global config; all default `true`:

| key | layer | what it skips |
| --- | --- | --- |
| `skip_already_fixed` | A | closing-keyword-linked merged PR |
| `skip_duplicates` | A | marked-as-duplicate / `duplicate` label |
| `verify_before_fix` | B | the verify-first step + no-diff/no-PR rule |

They resolve `repo > defaults > built-in default (on)`, so a config written before
triage existed gets the behavior automatically. The action defaults each input
`true`; the generated workflow renders an input only on **opt-out**, so a
default-on repo's workflow is byte-for-byte unchanged. Opt-in semantic duplicate
detection across the whole open backlog (an LLM pass) is a deferred follow-up.

## Invariants

Read-only GitHub edges for detection (no merge API; `no-merge.test.ts` unaffected);
the agent never holds a token (it emits a verdict, the host comments/labels/PRs);
the only new write is `addLabels` (Issues: write, already held) - no Administration
write.
