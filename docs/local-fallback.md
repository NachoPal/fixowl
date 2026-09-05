# Local fallback trigger

GitHub Actions `schedule` is best-effort: it silently drops or delays runs -
worst at the top of the hour, on public repos, and on the first cycle after a
change. When the nightly cron just doesn't fire, nothing happens and nothing
tells you.

The **local fallback trigger** is an opt-in safety net that runs on the same
host as the self-hosted runner. Shortly after the cron time it checks whether
today's scheduled run actually happened and, if it didn't, dispatches the
workflow itself. It is deliberately narrow: it backs up the cron without hiding
whether the cron works, and it never gets in the way of manual runs.

## How it decides (and why it can't double-spend)

The design keeps a **fixed daily usage budget**: the scheduled nightly run
executes at most once a day, whether the cron delivered it or the fallback did -
never both - while manual runs stay unrestricted. Two pure, unit-tested pieces
(`packages/core/src/fallback-dispatch.ts`) enforce exactly that:

1. **Pre-dispatch check** (`decideFallbackDispatch`, run by the launchd agent):
   dispatch only if there is no `event: schedule` run for today (UTC). A manual
   `workflow_dispatch` never counts, so it never suppresses the fallback.

2. **In-run budget guard** (`guardScheduledSlot`, run at the start of every night
   inside the action): a *scheduled-slot* run - a cron run, or a fallback-tagged
   dispatch - stands down as a clean no-op if an earlier scheduled-slot run
   already covered today. So a late cron arriving after the fallback (or vice
   versa) collapses to a single execution. A plain manual dispatch is never a
   scheduled-slot run and is never guarded, so you can run the workflow by hand
   as often as you like.

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

## The token: `FIXOWL_FALLBACK_TOKEN`

Dispatching a workflow requires **Actions: write**. fixowl's other two tokens
deliberately don't provide that for routine use (see [security.md](security.md)):
the admin token is setup-only and meant to be revoked or downgraded after
provisioning, and the runtime token is least-privilege and lives in the repo, not
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
the "already ran today?" decision keys on the UTC calendar day, the exact minute
doesn't matter as long as the fire is reliably after the cron, which this
guarantees.

The gap defaults to **30 minutes** (configurable via `fallback.gap_minutes`).
30 is deliberately generous: GitHub schedules also arrive *late*, and a too-tight
gap risks firing while a late-but-pending cron run is still queued.

> Caveat: the "today" window is the UTC calendar day, so keep the cron time away
> from UTC midnight (the defaults are). A cron within ~one gap of 00:00 UTC could
> push the fallback's fire into the next UTC day.

## Using it

Opt in during `fixowl init` (it prompts for the scoped token and installs the
agent), or set it up later:

```sh
# 1. Add FIXOWL_FALLBACK_TOKEN to ~/.fixowl/secrets.env and uncomment
#    github.fallback_token in ~/.fixowl/config.yaml.
# 2. Make sure the workflow is up to date (the fallback needs the `source` input
#    and the budget guard shipped with this feature):
fixowl provision
# 3. Install the launchd agent(s):
fixowl fallback install            # all repos; or: fixowl fallback install owner/repo

fixowl fallback status             # installed? next fire time?
fixowl status                      # also shows the fallback line per repo
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
