/**
 * Pure decision logic for the local fallback trigger (`fixowl fallback`) and the
 * scheduled-slot budget guard that pairs with it.
 *
 * GitHub's `schedule` cron is best-effort: it silently drops or delays runs. The
 * fallback is a host-local scheduled job that runs shortly after the cron and
 * dispatches the workflow only when the cron did not fire. It backs up the cron
 * without masking whether the cron itself works: a real cron run is recorded as
 * `event: schedule`, a fallback-triggered run is `event: workflow_dispatch`
 * carrying `source: scheduled-fallback` (surfaced in the run-name as the marker
 * below), and an ordinary manual run is an untagged `workflow_dispatch`. So an
 * operator can always tell the three apart and keep auditing cron health.
 *
 * The captain's constraint is a fixed daily usage budget: the *scheduled*
 * nightly run must execute at most once a day, whether the cron delivered it or
 * the fallback did - never both, because a second run still spends subscription
 * usage picking up newly-eligible issues even though per-issue branch
 * idempotency prevents duplicate PRs. At the same time *manual* runs stay
 * unrestricted: the operator may run the workflow by hand any number of times a
 * day. Two pieces enforce exactly that, and nothing more:
 *
 *  1. {@link decideFallbackDispatch} (the fallback script, before dispatching):
 *     dispatch only if the current occurrence has no `schedule` run yet. Manual
 *     dispatches never count, so they never suppress the fallback.
 *  2. {@link guardScheduledSlot} (inside the run, at start): a *scheduled-slot*
 *     run (a `schedule` run, or a fallback-tagged dispatch) stands down when an
 *     earlier scheduled-slot run already covers the current occurrence, so a
 *     late cron arriving after the fallback (or vice-versa) collapses to one
 *     execution. A plain manual dispatch is never a scheduled-slot run and is
 *     never guarded.
 *
 * ## The occurrence window (why not the UTC calendar day)
 *
 * "The current occurrence" is the half-open window
 * `[anchor, next occurrence)`, where `anchor` is the most recent scheduled cron
 * time at or before now, computed in UTC ({@link anchorOccurrence}). A run
 * covers the occurrence when it started at or after that anchor. This replaces
 * an earlier UTC-calendar-day window, which broke for a cron near UTC midnight:
 * a cron at 23:55 UTC fires on Monday, but its ~00:25 fallback check lands on
 * Tuesday and, keying off the calendar day, would miss Monday's run and wrongly
 * dispatch a duplicate. Anchoring to the occurrence keeps the on-time run and
 * its post-midnight check in one window, so they always dedupe to one run. When
 * the cron schedule is unavailable (an old workflow that does not pass it), both
 * pieces fall back to the UTC calendar day - the pre-anchoring behavior.
 */

/** The `source` workflow_dispatch input value the fallback sends. */
export const SCHEDULED_FALLBACK_SOURCE = "scheduled-fallback";

/**
 * Marker the workflow's `run-name` appends for a fallback-tagged dispatch, so a
 * fallback run is recognisable in the runs list (via `display_title`) without a
 * per-run fetch of its inputs.
 */
export const SCHEDULED_FALLBACK_MARKER = "[scheduled-fallback]";

/** A workflow run reduced to what the fallback decision and slot guard need. */
export interface WorkflowRunLite {
  id: number;
  /** GitHub run trigger, e.g. "schedule" | "workflow_dispatch". */
  event: string;
  /** "queued" | "in_progress" | "completed" | null. */
  status: string | null;
  /** ISO 8601 creation timestamp; GitHub returns these in UTC (a trailing "Z"). */
  createdAt: string;
  /** The run's display title (from `run-name`); carries the fallback marker. */
  displayTitle: string;
}

/** True when both instants fall on the same UTC calendar day. */
export function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** The hour/minute (UTC) of a daily `M H * * *` cron. */
export interface DailyCron {
  hourUtc: number;
  minuteUtc: number;
}

/**
 * Parses the hour/minute of a daily `M H * * *` cron (UTC), or returns undefined
 * when the expression is not a plain daily cron (five fields, numeric minute and
 * hour, and `*` for day-of-month, month, and day-of-week). Defensive on purpose:
 * callers that anchor to the occurrence degrade to the UTC calendar day rather
 * than throw when the schedule is missing or non-daily. (The CLI keeps its own
 * throwing parser with per-field messages for install-time validation.)
 */
export function tryParseDailyCron(cron: string): DailyCron | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dom, month, dow] = fields;
  if (dom !== "*" || month !== "*" || dow !== "*") return undefined;
  const minuteUtc = Number(minute);
  const hourUtc = Number(hour);
  if (!Number.isInteger(minuteUtc) || minuteUtc < 0 || minuteUtc > 59) return undefined;
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) return undefined;
  return { hourUtc, minuteUtc };
}

/**
 * The most recent daily-cron occurrence at or before `now`, computed in UTC.
 * This is the start of the current occurrence window `[anchor, next occurrence)`
 * (see the module comment): a scheduled run at or after this instant covers the
 * occurrence, so an on-time run just before UTC midnight and its post-midnight
 * fallback check fall in the same window and dedupe to one run.
 */
export function anchorOccurrence(cron: DailyCron, now: Date): Date {
  const anchor = new Date(now);
  anchor.setUTCHours(cron.hourUtc, cron.minuteUtc, 0, 0);
  if (anchor.getTime() > now.getTime()) anchor.setUTCDate(anchor.getUTCDate() - 1);
  return anchor;
}

/**
 * Whether a run belongs to a scheduled slot - i.e. it is the nightly run,
 * delivered either by the cron (`event: schedule`) or by the fallback (a
 * `workflow_dispatch` whose run-name carries {@link SCHEDULED_FALLBACK_MARKER}).
 * An ordinary manual dispatch is neither and returns false.
 */
export function isScheduledSlotRun(
  run: WorkflowRunLite,
  marker: string = SCHEDULED_FALLBACK_MARKER,
): boolean {
  if (run.event === "schedule") return true;
  return run.event === "workflow_dispatch" && run.displayTitle.includes(marker);
}

/**
 * The scheduled (cron) run for today (UTC), if GitHub already recorded one. The
 * calendar-day fallback used when no cron schedule is available to anchor the
 * occurrence window; {@link scheduledRunSince} is the anchored equivalent.
 *
 * Any status counts (queued / in_progress / completed): the run's mere existence
 * proves the cron fired, so dispatching again would be redundant - even a
 * queued-but-late cron run.
 */
export function scheduledRunToday(
  runs: readonly WorkflowRunLite[],
  now: Date,
): WorkflowRunLite | undefined {
  return runs.find((run) => run.event === "schedule" && isSameUtcDay(new Date(run.createdAt), now));
}

/**
 * The scheduled (cron) run that already covers the current occurrence, if any -
 * a `schedule`-event run created at or after `anchor` (the occurrence start).
 * Any status counts, for the same reason as {@link scheduledRunToday}.
 */
export function scheduledRunSince(
  runs: readonly WorkflowRunLite[],
  anchor: Date,
): WorkflowRunLite | undefined {
  return runs.find(
    (run) => run.event === "schedule" && new Date(run.createdAt).getTime() >= anchor.getTime(),
  );
}

export interface FallbackDecision {
  /** Whether to dispatch the workflow now. */
  dispatch: boolean;
  /** Operator-facing explanation of the decision, for the fallback's log. */
  reason: string;
  /** The scheduled run that made us stand down, when `dispatch` is false. */
  existing?: WorkflowRunLite;
}

/**
 * Decide whether the fallback should dispatch the workflow, given the repo's
 * recent workflow runs, the current time, and the repo's cron schedule. Dispatch
 * iff no scheduled (cron) run covers the current occurrence.
 *
 * The occurrence window is anchored to the cron: `[anchor, next occurrence)`,
 * where `anchor` is the most recent cron time at or before `now` (UTC). This
 * keeps an on-time cron just before UTC midnight and its post-midnight fallback
 * check in one window. When `cronSchedule` is absent or not a plain daily cron,
 * it degrades to the UTC calendar day. Manual `workflow_dispatch` runs are
 * ignored on purpose: the fallback backs up the *cron*, not the operator's runs.
 */
export function decideFallbackDispatch(
  runs: readonly WorkflowRunLite[],
  now: Date,
  cronSchedule?: string,
): FallbackDecision {
  const cronTime = cronSchedule !== undefined ? tryParseDailyCron(cronSchedule) : undefined;
  const window = cronTime !== undefined ? "since the current occurrence anchor" : "for today (UTC)";
  const existing =
    cronTime !== undefined
      ? scheduledRunSince(runs, anchorOccurrence(cronTime, now))
      : scheduledRunToday(runs, now);
  if (existing !== undefined) {
    return {
      dispatch: false,
      reason:
        `a scheduled run already exists ${window} (run #${existing.id}, ` +
        `status ${existing.status ?? "unknown"}, created ${existing.createdAt}); ` +
        `the cron is healthy - standing down`,
      existing,
    };
  }
  return {
    dispatch: true,
    reason:
      `no scheduled (cron) run found ${window}; ` +
      "dispatching the fallback via workflow_dispatch",
  };
}

export interface SlotGuardResult {
  /** Whether this run should do the night's work. */
  proceed: boolean;
  /** Operator-facing explanation, for the run's log/summary. */
  reason: string;
  /** The earlier scheduled-slot run this one defers to, when standing down. */
  supersededBy?: WorkflowRunLite;
}

export interface SlotGuardParams {
  /** Recent runs of this workflow (newest-first order is not required). */
  runs: readonly WorkflowRunLite[];
  /** Now, used to scope "today" to the current UTC calendar day. */
  now: Date;
  /** This run's id (GITHUB_RUN_ID). */
  currentRunId: number;
  /** Whether *this* run is itself a scheduled-slot run (cron or fallback-tagged). */
  selfIsScheduledSlot: boolean;
  /** Run-name marker identifying a fallback dispatch; overridable for tests. */
  marker?: string;
  /**
   * The repo's cron schedule (e.g. "55 23 * * *"), used to anchor the occurrence
   * window. Absent or non-daily degrades to the UTC calendar day (an old
   * workflow that does not pass its schedule through).
   */
  cronSchedule?: string;
}

/**
 * Decide whether a run may proceed, enforcing "the scheduled slot runs at most
 * once per day". A run that is not itself a scheduled-slot run (a plain manual
 * dispatch) always proceeds - manual runs are never budget-limited. A
 * scheduled-slot run proceeds only when it is the *earliest* scheduled-slot run
 * for today; any later one stands down as a clean no-op.
 *
 * "Earliest" is decided by run id, which GitHub assigns monotonically, so the
 * decision is deterministic even when a cron run and a fallback-tagged run were
 * created within the same instant (the workflow's `concurrency` group already
 * serialises their execution). Every status counts - a queued, in-progress, or
 * completed earlier slot run all mean the slot is already covered.
 *
 * "The current occurrence" is the anchored window `[anchor, next occurrence)`
 * when `params.cronSchedule` is a plain daily cron, and the UTC calendar day
 * otherwise (see the module comment).
 */
export function guardScheduledSlot(params: SlotGuardParams): SlotGuardResult {
  if (!params.selfIsScheduledSlot) {
    return {
      proceed: true,
      reason: "not a scheduled-slot run (manual dispatch); never budget-limited",
    };
  }
  const marker = params.marker ?? SCHEDULED_FALLBACK_MARKER;
  const cronTime =
    params.cronSchedule !== undefined ? tryParseDailyCron(params.cronSchedule) : undefined;
  const anchor = cronTime !== undefined ? anchorOccurrence(cronTime, params.now) : undefined;
  const coversOccurrence = (run: WorkflowRunLite): boolean =>
    anchor !== undefined
      ? new Date(run.createdAt).getTime() >= anchor.getTime()
      : isSameUtcDay(new Date(run.createdAt), params.now);
  const earlier = params.runs.find(
    (run) =>
      run.id < params.currentRunId && coversOccurrence(run) && isScheduledSlotRun(run, marker),
  );
  if (earlier !== undefined) {
    return {
      proceed: false,
      reason:
        `today's scheduled slot is already covered by run #${earlier.id} ` +
        `(${earlier.event}, status ${earlier.status ?? "unknown"}); ` +
        `standing down to keep the nightly run to one execution per day`,
      supersededBy: earlier,
    };
  }
  return {
    proceed: true,
    reason: "first scheduled-slot run today; proceeding",
  };
}
