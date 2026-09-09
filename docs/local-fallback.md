# Scheduling triggers & the host scheduler

GitHub Actions `schedule` is best-effort: it silently drops or delays runs -
worst at the top of the hour, on public repos, and on the first cycle after a
change. When the nightly cron just doesn't fire, nothing happens and nothing
tells you. Since fixowl's primary target is a **self-hosted runner**, the host
that runs the runner can also trigger the night on time itself, far more
reliably than GitHub's cron.

## Which trigger fires the night (the three modes)

`fixowl init` asks how each repo's nightly run should be triggered, and the
choice is recorded as `schedule_trigger` in `~/.fixowl/config.yaml` (per repo,
or under `defaults:`), so re-provision and later edits honor it. All three modes
still need a `schedule:` cron time in config - it is the *when*; the mode decides
*who fires it*.

| `schedule_trigger` | Workflow `on.schedule:` | Host launchd agent | Best for |
| --- | --- | --- | --- |
| `github-cron` | kept (cron) | **not installed** | a GitHub-*hosted* runner, or when you accept unreliable timing |
| `host-scheduler` **(recommended)** | **omitted** (dispatch-only) | **primary**: dispatches the workflow directly on schedule | a self-hosted runner |
| `both` | kept (cron) | **fallback**: dispatches only if the cron run is missing | belt-and-braces (cron + backup) |

- **`github-cron`** relies entirely on GitHub's cron. Simple, no host token
  needed, but the timing is unreliable - mainly worth it on a GitHub-hosted
  runner. No host agent is installed, and `fixowl fallback install` / `check`
  skip a `github-cron` repo (a host agent for it would dispatch unwanted nights,
  [issue #81](https://github.com/NachoPal/fixowl/issues/81)).
- **`host-scheduler`** (recommended for self-hosted) renders a **dispatch-only**
  workflow (`workflow_dispatch` only, no cron) and lets the host launchd agent
  dispatch the night **directly on schedule** - reliable local timing with no
  dependence on GitHub's cron. This is the launchd agent's **primary-dispatch**
  role (`decidePrimaryDispatch`): because the workflow has no cron, "no
  `schedule` run today" must **not** be read as "the cron missed"; it dispatches
  on schedule and only dedupes against a run already covering the occurrence.
- **`both`** keeps the workflow cron *and* installs the host agent in its
  **fallback** role (`decideFallbackDispatch`): the agent fires shortly after the
  cron and dispatches only if the cron run is missing - the belt-and-braces
  option.

Modes `host-scheduler` and `both` need the host [dispatch token](#the-token-fixowl_fallback_token);
`github-cron` needs none.

## How the host agent decides (and why it can't double-spend)

The design keeps a **fixed daily usage budget**: the scheduled nightly run
executes at most once a day, whether the cron delivered it or the fallback did -
never both - while manual runs stay unrestricted. Two pure, unit-tested pieces
(`packages/core/src/fallback-dispatch.ts`) enforce exactly that:

1. **Pre-dispatch check** (run by the launchd agent). The decision depends on the
   agent's role:
   - **fallback** (`decideFallbackDispatch`, mode `both`): dispatch only if there
     is no `event: schedule` run covering the current occurrence (see
     [the occurrence window](#the-occurrence-window) below). A manual
     `workflow_dispatch` never counts, so it never suppresses the fallback.
   - **primary** (`decidePrimaryDispatch`, mode `host-scheduler`): the workflow is
     dispatch-only, so there is no cron run to wait for. Dispatch on every
     scheduled fire, deduping only against a **scheduled-slot** run - a cron run,
     or a prior fallback-tagged dispatch - that already covers the occurrence
     (guards against a double launchd fire or a re-arm). This is the fix for
     [issue #81](https://github.com/NachoPal/fixowl/issues/81): a dispatch-only
     workflow never gets an unwanted "cron missed" dispatch.

2. **In-run budget guard** (`guardScheduledSlot`, run at the start of every night
   inside the action): a *scheduled-slot* run - a cron run, or a fallback-tagged
   dispatch - stands down as a clean no-op if an earlier scheduled-slot run
   already covered the current occurrence. So a late cron arriving after the
   fallback (or vice versa) collapses to a single execution. A plain manual
   dispatch is never a scheduled-slot run and is never guarded, so you can run
   the workflow by hand as often as you like.

   Only an earlier run that actually did (or may yet do) the night's work counts
   as covering the slot: one that **succeeded**, or is still **queued/in-progress**
   (GitHub reports both `status` and `conclusion`; the guard keys off both). An
   earlier scheduled-slot run that **completed but failed** (or was cancelled or
   timed out) did *not* run the night, so it does **not** consume the slot - the
   later run proceeds and the night runs. Re-running after a failed slot run is
   safe: per-issue branch idempotency (`issue/<n>-*`) skips any issue the failed
   run already shipped, so no duplicate PRs. (Before this rule a fallback that
   crashed at job setup would wrongly consume the slot and stand the real cron
   down, skipping the whole night.)

The fallback tags its dispatch with the `source: scheduled-fallback`
workflow input, surfaced in the run-name as `[scheduled-fallback]`, so:

- a **cron** run is `event: schedule`,
- a **fallback** run is `event: workflow_dispatch` named `… [scheduled-fallback]`,
- a **manual** run is a plain `event: workflow_dispatch`.

You can always tell the three apart in the Actions runs list and keep auditing
cron health - the fallback never masks a broken cron.

> Duplicate *PRs* were never the risk (per-issue branch idempotency and the
> workflow `concurrency` group already prevent those). The guard exists because a
> second run still spends subscription usage picking up newly-eligible issues.

### The occurrence window

Both pieces decide "already ran?" over the current **occurrence window**, the
half-open interval `[anchor, next occurrence)`, where `anchor` is the most recent
scheduled cron time at or before now (computed in UTC). A run covers the
occurrence when it started at or after that anchor.

This is deliberately **not** the UTC calendar day, which breaks for a cron near
UTC midnight. Worked example - cron `55 23 * * *` (23:55 UTC):

- The on-time cron fires **Mon 23:55**.
- The fallback pre-check runs **Tue 00:25**. `anchor(Tue 00:25) = Mon 23:55`, so
  it sees Monday's schedule run (its `created_at` is `>= anchor`) and **does not
  dispatch**.
- A plain UTC-calendar-day check would look only at *Tuesday*, miss Monday's run,
  and wrongly dispatch a duplicate.

The anchored window keeps an on-time run just before UTC midnight and its
post-midnight check in one occurrence, so they always dedupe to one run. The cron
is passed to the action as the `schedule` workflow input so the in-run guard can
compute the same anchor; an old workflow that predates this input degrades to the
UTC calendar day (harmless away from midnight). Manual (untagged) dispatches are
never guarded, regardless of window.

## The token: `FIXOWL_FALLBACK_TOKEN`

Dispatching a workflow requires **Actions: write**. fixowl's other credentials
deliberately don't provide that for routine use (see [security.md](security.md)):
the admin token is setup-only and meant to be revoked or downgraded after
provisioning, and the GitHub App is least-privilege and lives in the repo, not
on the host.

So the fallback uses its **own** dedicated, least-privilege token:

- A **fine-grained PAT** scoped to **only your target repos**, granting exactly
  **Actions: Read and write** (nothing else). Actions: write includes the read
  needed to list runs; metadata read is implicit.
- Stored on the host in `~/.fixowl/secrets.env` as `FIXOWL_FALLBACK_TOKEN`
  (mode 600), and referenced from `config.yaml` as
  `github.fallback_token: ${FIXOWL_FALLBACK_TOKEN}`.

Keeping it separate is the whole point: the fallback holds only Actions: write,
so **you can still revoke or downgrade the admin token** after provisioning and
the security model's "admin token is setup-only" property is preserved. The
token never appears in argv (it is passed to Octokit, not on a command line) and
is never committed.

## Timing and DST

The GitHub cron is fixed **UTC**. launchd's `StartCalendarInterval` fires in the
host's **local** wall-clock time, which shifts an hour with daylight saving. If
we naively converted "cron + gap" to a fixed local time, a DST change could make
that local time land *before* the cron for half the year, defeating the point.

fixowl schedules the agent at the local time of
`cronUTC + gap + the zone's larger (summer) UTC offset`
(`fallbackLocalTime`, `packages/cli/src/runner/fallback-launchd.ts`). Converted
back to UTC at either seasonal offset, the fire always lands between `gap` and
`gap + (DST swing)` after the cron - **never before it**, in any season. Because
the "already ran?" decision keys on the [occurrence window](#the-occurrence-window)
(anchored to the cron, not the calendar day), the exact minute doesn't matter as
long as the fire is reliably after the cron, which this guarantees - and the
anchoring means a cron near UTC midnight is handled correctly too.

The gap defaults to **30 minutes** (configurable via `fallback.gap_minutes`).
30 is deliberately generous: GitHub schedules also arrive *late*, and a too-tight
gap risks firing while a late-but-pending cron run is still queued.

In **`host-scheduler`** (primary) mode there is no cron to defer to, so the agent
fires **on** the schedule (gap 0) - it *is* the trigger. The `fallback.gap_minutes`
setting applies only to the **`both`** (fallback) role.

## Using it

Pick the trigger during `fixowl init`: choosing `host-scheduler` or `both`
prompts for the scoped token and installs the host agent. To change it later,
edit `schedule_trigger` in `~/.fixowl/config.yaml` (or set it under `defaults:`),
re-run `fixowl provision` so the workflow's `on.schedule:` matches, then:

```sh
# 1. For host-scheduler or both: add FIXOWL_FALLBACK_TOKEN to ~/.fixowl/secrets.env
#    and uncomment github.fallback_token in ~/.fixowl/config.yaml.
# 2. Bring the workflow in line with the chosen mode (adds/removes the cron; the
#    host agent needs the `source` input and the budget guard):
fixowl provision
# 3. Install the host agent(s). A `github-cron` repo is skipped automatically:
fixowl fallback install            # all repos; or: fixowl fallback install owner/repo

fixowl fallback status             # installed? primary or fallback? next fire time?
fixowl status                      # also shows the host-scheduler line per repo
fixowl fallback check owner/repo   # run the check-then-dispatch now (what launchd runs)
fixowl fallback uninstall          # remove the agent(s)
```

The agent logs each decision (fired vs skipped, with the reason) to
`~/.fixowl/logs/com.fixowl.fallback.<owner>-<repo>.log`.

## Platform support

Implemented for **macOS (launchd)**, the current host. The decision logic and
the check-then-dispatch command are platform-independent; only the scheduler is
macOS-specific. On Linux, add a `cron` entry or a systemd timer that runs
`fixowl fallback check <repo>` shortly after the cron - the same command the
launchd agent invokes. `fixowl fallback install` refuses cleanly on non-macOS
rather than pretending to work.
