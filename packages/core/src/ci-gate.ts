/**
 * Pure decision logic for the CI-gated fix loop. Real CI is the authority for
 * whether a fixowl PR is ready-for-review or must stay a draft: after the agent
 * pushes, the runner waits for the head SHA's *required* checks and, if they are
 * red, feeds the failures back to the agent and tries again.
 *
 * This module has no I/O: it decides which checks gate the PR, whether the
 * gating set has settled, and whether it is green. The polling/waiting and the
 * GitHub calls live at the edges (packages/action/src/ci-poll.ts and entry.ts).
 */

/** One check on a ref: a GitHub Actions check run or a legacy commit status, normalized. */
export interface CheckStatusLite {
  /** Check-run name or status context. Matched against required contexts by exact string. */
  name: string;
  /** Lifecycle phase; only "completed" checks carry a meaningful conclusion. */
  status: "queued" | "in_progress" | "completed";
  /**
   * Terminal result of a completed check. null while still running. A failure
   * kind (see `isFailureConclusion`) turns the PR red; success/neutral/skipped
   * are treated as passing.
   */
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "stale"
    | "startup_failure"
    | "skipped"
    | null;
  /** Human summary for the PR body / agent feedback (bounded upstream); best-effort. */
  summary?: string;
  /** Link to the check's run/logs for the PR body; best-effort. */
  detailsUrl?: string;
}

/**
 * The required status-check contexts for a base branch. `readable` is true only
 * when we actually read a non-empty required-checks rule (branch protection or
 * ruleset). When it is false - no branch protection, a rule with no contexts,
 * or an unreadable one (insufficient scope) - the loop falls back to gating on
 * all completed checks and logs a warning; it never fails loud (captain 7.2).
 */
export interface RequiredChecks {
  readable: boolean;
  contexts: string[];
}

/** Conclusions that make a completed check count as a failure (turns the PR red). */
export function isFailureConclusion(conclusion: CheckStatusLite["conclusion"]): boolean {
  return (
    conclusion === "failure" ||
    conclusion === "cancelled" ||
    conclusion === "timed_out" ||
    conclusion === "action_required" ||
    conclusion === "stale" ||
    conclusion === "startup_failure"
  );
}

export interface GatingChecks {
  /** The checks the PR is gated on this poll. */
  checks: CheckStatusLite[];
  /** True when we fell back to "all checks" because the required set was unreadable. */
  usedFallback: boolean;
}

/**
 * Which checks gate readiness. When the required set is readable, gate strictly
 * on the checks whose name matches a required context; otherwise fall back to
 * every check on the ref (captain 7.2).
 */
export function gatingChecks(all: CheckStatusLite[], required: RequiredChecks): GatingChecks {
  if (required.readable) {
    const wanted = new Set(required.contexts);
    return { checks: all.filter((check) => wanted.has(check.name)), usedFallback: false };
  }
  return { checks: all, usedFallback: true };
}

export type GateDecision = "green" | "failed" | "pending";

/**
 * Decide the gate from one poll's checks.
 *
 * Readable required set: the PR is settled only when every required context is
 * present *and* completed - a required context that has not appeared yet keeps
 * us pending (branch protection guarantees it must run), so a slow-to-register
 * check is never mistaken for "no CI".
 *
 * Fallback set: settled when no check is still running. With zero checks this
 * is "green" here - "gate on all completed checks" is vacuously satisfied when
 * there are none - but that reading is ambiguous: it cannot tell "no CI
 * configured" from "CI has not registered its checks yet" in the seconds after a
 * push. The poll loop (ci-poll.ts) resolves that ambiguity with a settle window,
 * holding a zero-check fallback green until it elapses; this pure decision only
 * reports the vacuous result.
 */
export function evaluateGate(gating: GatingChecks, required: RequiredChecks): GateDecision {
  if (required.readable) {
    const present = new Map(gating.checks.map((check) => [check.name, check]));
    const matched = required.contexts.map((context) => present.get(context));
    if (matched.some((check) => check === undefined || check.status !== "completed")) {
      return "pending";
    }
    return matched.some((check) => isFailureConclusion(check?.conclusion ?? null))
      ? "failed"
      : "green";
  }
  if (gating.checks.some((check) => check.status !== "completed")) return "pending";
  return gating.checks.some((check) => isFailureConclusion(check.conclusion)) ? "failed" : "green";
}

/** The completed, failing checks from a gating set - what the agent must fix next. */
export function failedChecks(gating: GatingChecks): CheckStatusLite[] {
  return gating.checks.filter(
    (check) => check.status === "completed" && isFailureConclusion(check.conclusion),
  );
}
