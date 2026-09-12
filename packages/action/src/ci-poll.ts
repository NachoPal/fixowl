import {
  evaluateGate,
  failedChecks,
  gatingChecks,
  requiredContextsStalled,
  type CheckStatusLite,
  type ChecksForRef,
  type RequiredChecks,
} from "@fixowl/core";
import type { GitHubApi, Logger, PullRequestMergeState } from "./deps.ts";

/** Default gap between polls of a pushed head's checks. */
export const CI_POLL_INTERVAL_MS = 15_000;

/** Default gap between polls of a PR's mergeability while GitHub is still computing it. */
export const MERGEABILITY_POLL_INTERVAL_MS = 3_000;

/**
 * How long to wait for GitHub to finish computing a PR's mergeability
 * (`mergeable: null` -> known) before the conflict gate falls open to `proceed`.
 * Small: the computation normally lands within a second or two of a push, and a
 * still-unknown state must never block the night - the CI wait then runs as it
 * did before this gate existed.
 */
export const MERGEABILITY_RESOLVE_TIMEOUT_MS = 60_000;

/**
 * How many *consecutive* transient read errors the poll loop absorbs before it
 * gives up. A single 502 / ECONNRESET / secondary-rate-limit 403 during the wait
 * must not abort the issue and strand the pushed draft (issue #73), but a run of
 * them means the read is genuinely broken, so re-throw and let the caller handle
 * it. A successful read resets the counter.
 */
export const CI_POLL_MAX_CONSECUTIVE_ERRORS = 5;

/**
 * In fallback mode (required set unreadable) an empty poll is ambiguous: CI may
 * genuinely not exist, or its check runs may just not have registered yet in the
 * seconds after a push. So a zero-check fallback poll is not accepted as green
 * until this settle window has elapsed with still no checks; once any check
 * appears the normal fallback decision applies immediately. Defaults to two poll
 * intervals and is bounded by the overall timeout at the call site.
 */
export const CI_FALLBACK_SETTLE_MS = 2 * CI_POLL_INTERVAL_MS;

/** Injectable clock so the wait is deterministic and instant in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface WaitForChecksResult {
  /**
   * Green when every gating check passed; failed on a red or timed-out attempt;
   * `unverified` when the ref's check runs could not be read at all (the runtime
   * token 403s on the check-runs API); `stalled` when a *required* context never
   * registered after the settle window (a path-filtered / dispatch-only /
   * uninstalled-app check that GitHub reports "Expected" forever), so waiting out
   * the timeout and re-running the agent would achieve nothing (issue #74).
   * `unverified` is distinct from `green`: no check was ever consulted, so the PR
   * must never be reported as CI-green even though it is still flipped to ready
   * after the settle window (captain 7.2). `stalled` leaves an annotated draft.
   */
  outcome: "green" | "failed" | "unverified" | "stalled";
  /** True when the wait hit `timeoutMs` before the gating set settled. */
  timedOut: boolean;
  /** The gating checks seen on the final poll (used to build agent feedback). */
  gating: CheckStatusLite[];
  /** The completed, failing checks on the final poll. */
  failed: CheckStatusLite[];
  /**
   * True when the *required* set was unreadable and we gated on all completed
   * checks (still a real, readable gate). This is NOT the check-runs-unreadable
   * case, which is reported as `outcome: "unverified"` instead.
   */
  usedFallback: boolean;
}

/**
 * Polls `sha`'s checks until the gating set settles (green or red) or `timeoutMs`
 * elapses. The pure gate decision lives in `@fixowl/core` (ci-gate.ts); this only
 * drives the loop, warns once on the required-checks fallback, and reports the
 * final failing checks. A timeout is reported as a failed attempt with the
 * checks still in flight, so the caller can note "CI did not complete in time".
 */
export async function waitForRequiredChecks(
  deps: { github: GitHubApi; log: Logger; clock: Clock },
  params: {
    sha: string;
    base: string;
    required: RequiredChecks;
    timeoutMs: number;
    pollMs?: number;
    /** Consecutive transient read errors tolerated before giving up (issue #73). */
    maxPollErrors?: number;
  },
): Promise<WaitForChecksResult> {
  const { github, log, clock } = deps;
  const pollMs = params.pollMs ?? CI_POLL_INTERVAL_MS;
  const maxPollErrors = params.maxPollErrors ?? CI_POLL_MAX_CONSECUTIVE_ERRORS;
  const start = clock.now();
  const settleMs = Math.min(2 * pollMs, params.timeoutMs);
  let warnedFallback = false;
  let warnedUnreadable = false;
  let consecutiveErrors = 0;

  for (;;) {
    let checks: ChecksForRef;
    try {
      checks = await github.getChecksForRef(params.sha);
      consecutiveErrors = 0;
    } catch (error) {
      // A single transient read error (502 / ECONNRESET / secondary-rate-limit
      // 403 - the last two the read edge re-throws by design, so as not to mistake
      // a rate limit for "no CI") must NOT abort the issue and strand the pushed
      // draft (issue #73). Absorb it and keep polling; give up only after
      // `maxPollErrors` in a row or once the overall timeout elapses - the head's
      // checks are simply unknown, so let the caller (processIssue) annotate the
      // draft it already opened rather than crash.
      consecutiveErrors += 1;
      log.warn(
        `transient error reading checks for ${params.sha} (${String(error)}); ` +
          `${consecutiveErrors}/${maxPollErrors} consecutive, continuing to poll`,
      );
      if (consecutiveErrors >= maxPollErrors || clock.now() - start >= params.timeoutMs) {
        throw error;
      }
      await clock.sleep(pollMs);
      continue;
    }
    // The runtime credential could not read the ref's checks at all (an App
    // installation without Checks: read is 403'd). CI cannot be verified,
    // so settle then flip to ready as the no-CI fallback does (captain 7.2), but
    // report it as a distinct `unverified` outcome - never green - so the PR body
    // and issue comment tell the human CI was never consulted, matching the loud
    // runner-log warning below.
    if (!checks.readable) {
      if (!warnedUnreadable) {
        warnedUnreadable = true;
        log.warn(
          `could not read checks for ${params.sha} (403 - not accessible to the runtime ` +
            `token); CI NOT verified for ${params.base} - proceeding to ready after settle`,
        );
      }
      if (clock.now() - start < settleMs) {
        await clock.sleep(pollMs);
        continue;
      }
      return {
        outcome: "unverified",
        timedOut: false,
        gating: [],
        failed: [],
        usedFallback: false,
      };
    }
    const all = checks.checks;
    const gating = gatingChecks(all, params.required);
    if (gating.usedFallback && !warnedFallback) {
      warnedFallback = true;
      log.warn(
        `required checks for ${params.base} are unreadable (no branch protection or insufficient ` +
          `token scope); gating on all completed checks instead`,
      );
    }
    const decision = evaluateGate(gating, params.required);
    // A zero-check fallback green is only vacuous CI not registering yet vs. no
    // CI configured; hold it until the settle window elapses, but accept a
    // non-empty fallback set (or any readable-required decision) immediately.
    const withinSettleWindow =
      gating.usedFallback && gating.checks.length === 0 && clock.now() - start < settleMs;
    if (decision !== "pending" && !withinSettleWindow) {
      return {
        outcome: decision,
        timedOut: false,
        gating: gating.checks,
        failed: failedChecks(gating),
        usedFallback: gating.usedFallback,
      };
    }
    // After the settle window, a required context that never registered (missing,
    // with nothing in flight) will never run for this change; stop now rather than
    // waiting out the full timeout and re-running the paid agent (issue #74).
    if (
      decision === "pending" &&
      clock.now() - start >= settleMs &&
      requiredContextsStalled(gating, params.required)
    ) {
      log.warn(
        `required check(s) for ${params.base} never started for ${params.sha} after the settle ` +
          `window; leaving an annotated draft instead of waiting out the timeout`,
      );
      return {
        outcome: "stalled",
        timedOut: false,
        gating: gating.checks,
        failed: failedChecks(gating),
        usedFallback: gating.usedFallback,
      };
    }
    if (clock.now() - start >= params.timeoutMs) {
      return {
        outcome: "failed",
        timedOut: true,
        gating: gating.checks,
        failed: failedChecks(gating),
        usedFallback: gating.usedFallback,
      };
    }
    await clock.sleep(pollMs);
  }
}

/**
 * Reads a PR's mergeability, polling while GitHub is still computing it
 * (`mergeable: null`). Returns as soon as `mergeable` is known (`true`/`false`),
 * or the last-seen (still-null) state once `timeoutMs` elapses - the caller then
 * falls open to the normal CI wait, so an unknowable mergeability never blocks
 * the night. The read edge is itself fail-open (github-api.ts), so this never
 * throws. See conflict-gate.ts::classifyMergeability.
 */
export async function resolveMergeability(
  deps: { github: GitHubApi; clock: Clock },
  params: { prNumber: number; timeoutMs: number; pollMs?: number },
): Promise<PullRequestMergeState> {
  const { github, clock } = deps;
  const pollMs = params.pollMs ?? MERGEABILITY_POLL_INTERVAL_MS;
  const start = clock.now();
  for (;;) {
    const state = await github.getPullRequestMergeState(params.prNumber);
    if (state.mergeable !== null) return state;
    if (clock.now() - start >= params.timeoutMs) return state;
    await clock.sleep(pollMs);
  }
}
