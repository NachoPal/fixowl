import {
  evaluateGate,
  failedChecks,
  gatingChecks,
  type CheckStatusLite,
  type RequiredChecks,
} from "@fixowl/core";
import type { GitHubApi, Logger } from "./deps.ts";

/** Default gap between polls of a pushed head's checks. */
export const CI_POLL_INTERVAL_MS = 15_000;

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
  /** Green when every gating check passed; otherwise a red or timed-out attempt. */
  outcome: "green" | "failed";
  /** True when the wait hit `timeoutMs` before the gating set settled. */
  timedOut: boolean;
  /** The gating checks seen on the final poll (used to build agent feedback). */
  gating: CheckStatusLite[];
  /** The completed, failing checks on the final poll. */
  failed: CheckStatusLite[];
  /** True when the required set was unreadable and we gated on all checks. */
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
  },
): Promise<WaitForChecksResult> {
  const { github, log, clock } = deps;
  const pollMs = params.pollMs ?? CI_POLL_INTERVAL_MS;
  const start = clock.now();
  let warnedFallback = false;

  for (;;) {
    const all = await github.getChecksForRef(params.sha);
    const gating = gatingChecks(all, params.required);
    if (gating.usedFallback && !warnedFallback) {
      warnedFallback = true;
      log.warn(
        `required checks for ${params.base} are unreadable (no branch protection or insufficient ` +
          `token scope); gating on all completed checks instead`,
      );
    }
    const decision = evaluateGate(gating, params.required);
    if (decision !== "pending") {
      return {
        outcome: decision,
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
