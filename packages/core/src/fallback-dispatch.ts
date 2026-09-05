/**
 * Pure decision logic for the local fallback trigger (`fixowl fallback`).
 *
 * GitHub's `schedule` cron is best-effort: it silently drops or delays runs. The
 * fallback is a host-local scheduled job that runs shortly after the cron and
 * dispatches the workflow only when the cron did not fire. It backs up the cron
 * without masking whether the cron itself works: a real cron run is recorded as
 * `event: schedule`, while a fallback-triggered run is `event: workflow_dispatch`,
 * so an operator can always tell them apart and keep auditing cron health.
 *
 * Deliberately scoped to the *scheduled* run only. Manual `workflow_dispatch`
 * runs (an operator's `fixowl run`, or a prior fallback) never count and never
 * block the fallback: the operator stays free to run the workflow by hand any
 * number of times a day. Duplicate *work* is not this decision's concern - the
 * workflow's `concurrency` group serializes overlapping runs and per-issue
 * branch idempotency skips issues already branched, so a redundant run is at
 * worst a near-empty no-op, never a duplicate PR.
 */

/** A workflow run reduced to what the fallback decision needs. */
export interface WorkflowRunLite {
  id: number;
  /** GitHub run trigger, e.g. "schedule" | "workflow_dispatch". */
  event: string;
  /** "queued" | "in_progress" | "completed" | null. */
  status: string | null;
  /** ISO 8601 creation timestamp; GitHub returns these in UTC (a trailing "Z"). */
  createdAt: string;
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
 * exists for today (UTC).
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
