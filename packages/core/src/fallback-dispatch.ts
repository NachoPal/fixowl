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
 *     dispatch only if today has no `schedule` run yet. Manual dispatches never
 *     count, so they never suppress the fallback.
 *  2. {@link guardScheduledSlot} (inside the run, at start): a *scheduled-slot*
 *     run (a `schedule` run, or a fallback-tagged dispatch) stands down when an
 *     earlier scheduled-slot run already exists for today, so a late cron
 *     arriving after the fallback (or vice-versa) collapses to one execution. A
 *     plain manual dispatch is never a scheduled-slot run and is never guarded.
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
 * The scheduled (cron) run for today, if GitHub already recorded one.
 *
 * "Today" is the UTC calendar day of `now`, matching GitHub cron, which always
 * fires in UTC. Any status counts (queued / in_progress / completed): the run's
 * mere existence proves the cron fired today, so the fallback must stand down -
 * even a queued-but-late cron run means dispatching again would be redundant.
 */
export function scheduledRunToday(
  runs: readonly WorkflowRunLite[],
  now: Date,
): WorkflowRunLite | undefined {
  return runs.find((run) => run.event === "schedule" && isSameUtcDay(new Date(run.createdAt), now));
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
 * recent workflow runs and the current time. Dispatch iff no scheduled run
 * exists for today (UTC). Manual `workflow_dispatch` runs are ignored on
 * purpose: the fallback backs up the *cron*, not the operator's own runs.
 */
export function decideFallbackDispatch(
  runs: readonly WorkflowRunLite[],
  now: Date,
): FallbackDecision {
  const cron = scheduledRunToday(runs, now);
  if (cron !== undefined) {
    return {
      dispatch: false,
      reason:
        `today's scheduled run already exists (run #${cron.id}, ` +
        `status ${cron.status ?? "unknown"}, created ${cron.createdAt}); ` +
        `the cron is healthy - standing down`,
      existing: cron,
    };
  }
  return {
    dispatch: true,
    reason:
      "no scheduled (cron) run found for today (UTC); " +
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
 */
export function guardScheduledSlot(params: SlotGuardParams): SlotGuardResult {
  if (!params.selfIsScheduledSlot) {
    return {
      proceed: true,
      reason: "not a scheduled-slot run (manual dispatch); never budget-limited",
    };
  }
  const marker = params.marker ?? SCHEDULED_FALLBACK_MARKER;
  const earlier = params.runs.find(
    (run) =>
      run.id !== params.currentRunId &&
      run.id < params.currentRunId &&
      isSameUtcDay(new Date(run.createdAt), params.now) &&
      isScheduledSlotRun(run, marker),
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
