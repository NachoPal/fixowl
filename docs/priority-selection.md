# Priority-label issue selection

By default fixowl picks up every open issue matching the pickup-label rule,
sorts them oldest-first, and works the first `max_issues_per_run` that survive
the branch-idempotency filter and the triage gate. For a repo with a large
backlog that means two things you may not want: the newest-but-most-urgent issue
waits behind a long tail of old ones, and every night fetches the *entire*
matching backlog just to keep a handful.

Priority-label selection fixes both. You tag issues with a family of priority
labels; fixowl then fills the run cap **highest-priority-first** and fetches
roughly the cap **tier-by-tier** instead of the whole backlog.

It is **opt-in**. A repo that configures no priority labels selects exactly as
before.

## Configuring it

Add a `priority` block to a repo entry (or to `defaults` for every repo) in
`~/.fixowl/config.yaml`:

```yaml
repos:
  - name: you/your-repo
    priority:
      # Ordered highest -> lowest. The ARRAY ORDER is the precedence; the names
      # are yours to choose. These three are what `fixowl init` offers.
      labels:
        - "priority: high"
        - "priority: medium"
        - "priority: low"
      # Whether issues carrying NONE of the above are still worked, as the lowest
      # tier (so nothing is starved). Default: true.
      include_unlabeled: true
```

`fixowl provision` creates any missing priority labels on the repo (a distinct
color, like it does for pickup and selector labels), so applying them Just Works.

Resolution is `repo > defaults`; an unset `priority` block on both stays
**off** (empty labels), so a config written before this feature is unchanged.
The block is taken whole (not deep-merged), so the ordered list is never
ambiguous - the same rule `label_models` follows.

## How the cap fills (bounded, tier-by-tier)

fixowl queries one tier at a time, highest-first, in bounded pages of
`max_issues_per_run`, and stops as soon as the cap is filled with *eligible*
issues:

```
for tier in [high, medium, low, (unlabeled)]:      # highest priority first
  page the tier (per_page = cap):
    drop issues already carrying `fixowl:triaged`
    keepEligible = branch-idempotency filter + Layer A triage gate   # per page
    accumulate the survivors
    stop when the cap is filled, or the tier is exhausted (a short/empty page)
```

Because a candidate counts toward the cap only **after** it survives the branch
filter and the Layer-A triage gate, heavy filtering makes the loop page *further
into the same tier* rather than come up short while higher-priority work is still
unfetched. The fetch is `O(cap)`, not `O(backlog)`.

The GitHub call is REST `issues.listForRepo` with `labels=<pickup>,<tier>` (a
strict AND), `sort=created&direction=asc` (oldest-first within a tier), and
`per_page`/`page` for the bounded paging - the same endpoint and rate-limit
bucket the rest of the run already uses, so there is no new rate surface. See
`packages/action/src/priority-selection.ts` and the `listOpenIssuesPage` edge in
`github-api.ts`.

### The unlabeled tier

With `include_unlabeled: true` (the default), issues carrying **none** of the
configured priority labels form the final, lowest tier - so an un-triaged issue
is still eventually worked, just after everything with an explicit priority. Set
`include_unlabeled: false` to work **only** issues that carry a priority label.

## Precedence: priority never beats `blocked_by`

Priority decides **which** issues are selected and their order. It does **not**
override dependencies. Layer 1 (`prereq-planner.ts`) keeps full authority over
native `blocked_by` edges: its topological sort always places a prerequisite
before its dependent, so a *low*-priority prerequisite of a *high*-priority issue
still runs first. **Prerequisites always win.**

Priority is only the **tiebreak** among issues the dependency graph leaves
unconstrained - so independent high-priority issues also *run* earlier in the
night (which matters if a run budget cuts the night short). With priority off,
that tiebreak is exactly the old oldest-first order.

One honest edge case: if a selected high-priority issue depends on a
lower-priority prerequisite that falls **below the cap line** (and so is not
selected), Layer 1 defers the dependent that night - the same thing today's
oldest-first selection does when a dependent's prerequisite is a newer issue
outside the cap. The prerequisite is picked up on a later night, or you raise its
priority.

## Interaction with the triage gate and Layer 2

- **Triage gate (Layer A/B, `docs/issue-triage.md`):** priority runs the *same*
  Layer-A gate, just once per fetched page instead of once over the whole
  backlog. A `fixowl:triaged` issue is excluded from selection exactly as before;
  a Layer-A skip still leaves its comment + label and appears under
  `## Triaged out`.
- **Layer 2 (`heuristic_conflict_ordering`, `docs/stacked-prs.md`):** unchanged
  and independent. It groups the selected issues by shared files; priority stays
  the tiebreak where grouping and dependencies leave order free.

## Turning it off

Delete the `priority` block (or set `labels: []`). Selection returns to
list-all, oldest-first, cap - byte-for-byte the pre-feature behavior. Existing
priority *labels* on issues are then ignored (they cause no pickup on their own).
