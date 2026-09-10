import type { CheckStatusLite } from "@fixowl/core";
import { describe, expect, it } from "vitest";
import { waitForRequiredChecks, type Clock } from "./ci-poll.ts";
import type { Logger } from "./deps.ts";
import { FakeGitHub, issue, silentLog } from "./test-helpers.ts";

/** A clock that advances by whatever it is asked to sleep - instant, deterministic. */
function fakeClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

function capturingLog(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, log: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} } };
}

const completed = (name: string, conclusion: CheckStatusLite["conclusion"]): CheckStatusLite => ({
  name,
  status: "completed",
  conclusion,
});
const running = (name: string): CheckStatusLite => ({
  name,
  status: "in_progress",
  conclusion: null,
});

describe("waitForRequiredChecks", () => {
  it("returns green once the required checks complete across polls", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    let calls = 0;
    github.checksForRef = () => {
      calls++;
      return calls < 3 ? [running("ci")] : [completed("ci", "success")];
    };
    const result = await waitForRequiredChecks(
      { github, log: silentLog, clock: fakeClock() },
      {
        sha: "sha",
        base: "main",
        required: { readable: true, contexts: ["ci"] },
        timeoutMs: 600_000,
      },
    );
    expect(result.outcome).toBe("green");
    expect(result.timedOut).toBe(false);
    expect(calls).toBe(3);
  });

  it("returns a red result with the failing checks", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    github.checksForRef = () => [completed("ci", "failure"), completed("lint", "success")];
    const result = await waitForRequiredChecks(
      { github, log: silentLog, clock: fakeClock() },
      {
        sha: "sha",
        base: "main",
        required: { readable: true, contexts: ["ci"] },
        timeoutMs: 600_000,
      },
    );
    expect(result.outcome).toBe("failed");
    expect(result.timedOut).toBe(false);
    expect(result.failed.map((c) => c.name)).toEqual(["ci"]);
  });

  it("times out when the required checks never complete", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    let calls = 0;
    github.checksForRef = () => {
      calls++;
      return [running("ci")];
    };
    const result = await waitForRequiredChecks(
      { github, log: silentLog, clock: fakeClock() },
      {
        sha: "sha",
        base: "main",
        required: { readable: true, contexts: ["ci"] },
        timeoutMs: 30_000,
        pollMs: 15_000,
      },
    );
    expect(result.outcome).toBe("failed");
    expect(result.timedOut).toBe(true);
    // polls at t=0, 15000, 30000 (>= timeout) -> 3 looks
    expect(calls).toBe(3);
  });

  it("falls back to all checks and warns once when the required set is unreadable", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    github.checksForRef = () => [completed("anything", "success")];
    const { log, warnings } = capturingLog();
    const result = await waitForRequiredChecks(
      { github, log, clock: fakeClock() },
      { sha: "sha", base: "main", required: { readable: false, contexts: [] }, timeoutMs: 600_000 },
    );
    expect(result.outcome).toBe("green");
    expect(result.usedFallback).toBe(true);
    expect(warnings.some((w) => w.includes("unreadable"))).toBe(true);
  });

  it("does not vacuously green a fallback poll before a late check registers", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    let calls = 0;
    github.checksForRef = () => {
      calls++;
      // Checks have not registered yet on the first poll (common right after a
      // push); a failing check appears on a later poll and must decide the gate.
      return calls < 2 ? [] : [completed("ci", "failure")];
    };
    const result = await waitForRequiredChecks(
      { github, log: silentLog, clock: fakeClock() },
      { sha: "sha", base: "main", required: { readable: false, contexts: [] }, timeoutMs: 600_000 },
    );
    expect(result.outcome).toBe("failed");
    expect(result.usedFallback).toBe(true);
    expect(result.failed.map((c) => c.name)).toEqual(["ci"]);
  });

  it("degrades to settle->unverified with a loud warning when the checks cannot be read (403), never throwing", async () => {
    // Reproduces the bug: a runtime credential without Checks: read cannot read
    // the check-runs API, so the read edge returns readable:false. The gate must NOT throw or
    // fail the issue; it must warn loudly that CI was not verified and flip to
    // ready after the settle window. The outcome is a DISTINCT `unverified` (not
    // green): zero checks were consulted, so the PR must never be reported green.
    const github = new FakeGitHub([issue(1, "t")]);
    github.checksReadable = false;
    // Even a required set that is itself readable must not keep the gate pending
    // forever when the checks behind it cannot be read.
    let calls = 0;
    github.checksForRef = () => {
      calls++;
      return [];
    };
    const { log, warnings } = capturingLog();
    const result = await waitForRequiredChecks(
      { github, log, clock: fakeClock() },
      {
        sha: "sha",
        base: "main",
        required: { readable: true, contexts: ["ci"] },
        timeoutMs: 600_000,
        pollMs: 15_000,
      },
    );
    expect(result.outcome).toBe("unverified");
    expect(result.timedOut).toBe(false);
    // Not the required-set fallback: no readable gate was consulted at all.
    expect(result.usedFallback).toBe(false);
    // Loud, explicit warning so an operator knows CI gating was skipped.
    expect(warnings.some((w) => /could not read checks/i.test(w) && /not verified/i.test(w))).toBe(
      true,
    );
    // Warned once, and held for the settle window (polls at t=0, 15000, 30000).
    expect(warnings.filter((w) => /could not read checks/i.test(w))).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it("absorbs a single transient read error mid-poll and keeps polling (issue #73)", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    let calls = 0;
    // The second poll throws (a 502 / ECONNRESET / secondary-rate-limit), which
    // must NOT abort the issue and strand the pushed draft; the loop absorbs it and
    // the third poll settles the gate green.
    github.getChecksForRef = async () => {
      calls++;
      if (calls === 2) throw new Error("502 Bad Gateway");
      return {
        readable: true,
        checks: calls < 3 ? [running("ci")] : [completed("ci", "success")],
      };
    };
    const { log, warnings } = capturingLog();
    const result = await waitForRequiredChecks(
      { github, log, clock: fakeClock() },
      {
        sha: "sha",
        base: "main",
        required: { readable: true, contexts: ["ci"] },
        timeoutMs: 600_000,
      },
    );
    expect(result.outcome).toBe("green");
    expect(result.timedOut).toBe(false);
    expect(calls).toBe(3);
    expect(warnings.some((w) => /transient error reading checks/i.test(w))).toBe(true);
  });

  it("gives up after N consecutive read errors instead of looping forever (issue #73)", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    let calls = 0;
    github.getChecksForRef = async () => {
      calls++;
      throw new Error("ECONNRESET");
    };
    await expect(
      waitForRequiredChecks(
        { github, log: silentLog, clock: fakeClock() },
        {
          sha: "sha",
          base: "main",
          required: { readable: true, contexts: ["ci"] },
          timeoutMs: 600_000,
          maxPollErrors: 3,
        },
      ),
    ).rejects.toThrow("ECONNRESET");
    // Read attempted exactly maxPollErrors times, then it re-throws.
    expect(calls).toBe(3);
  });

  it("stalls (does not wait out the timeout) when a required context never registers (issue #74)", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    let calls = 0;
    // "ci" completes green, but the required "e2e" context (a path-filtered / dispatch-only
    // job) never appears. Waiting the full timeout and re-running the agent would
    // achieve nothing, so after the settle window the wait returns `stalled`.
    github.checksForRef = () => {
      calls++;
      return [completed("ci", "success")];
    };
    const result = await waitForRequiredChecks(
      { github, log: silentLog, clock: fakeClock() },
      {
        sha: "sha",
        base: "main",
        required: { readable: true, contexts: ["ci", "e2e"] },
        timeoutMs: 600_000,
        pollMs: 15_000,
      },
    );
    expect(result.outcome).toBe("stalled");
    expect(result.timedOut).toBe(false);
    // Held for the settle window (2 * pollMs); polls at t=0, 15000, 30000 -> 3 looks,
    // not the ~40 the full timeout would have taken.
    expect(calls).toBe(3);
  });

  it("keeps waiting (not stalled) while a missing required context is still in flight (issue #74)", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    let calls = 0;
    // "e2e" is still running; a stalled verdict here would be wrong. It completes
    // red on a later poll and decides the gate.
    github.checksForRef = () => {
      calls++;
      return calls < 4
        ? [completed("ci", "success"), running("e2e")]
        : [completed("ci", "success"), completed("e2e", "failure")];
    };
    const result = await waitForRequiredChecks(
      { github, log: silentLog, clock: fakeClock() },
      {
        sha: "sha",
        base: "main",
        required: { readable: true, contexts: ["ci", "e2e"] },
        timeoutMs: 600_000,
        pollMs: 15_000,
      },
    );
    expect(result.outcome).toBe("failed");
    expect(result.failed.map((c) => c.name)).toEqual(["e2e"]);
  });

  it("greens only after the settle window when there is no CI at all (unreadable + no checks)", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    let calls = 0;
    github.checksForRef = () => {
      calls++;
      return [];
    };
    const result = await waitForRequiredChecks(
      { github, log: silentLog, clock: fakeClock() },
      {
        sha: "sha",
        base: "main",
        required: { readable: false, contexts: [] },
        timeoutMs: 600_000,
        pollMs: 15_000,
      },
    );
    expect(result.outcome).toBe("green");
    expect(result.timedOut).toBe(false);
    // settle window is 2 * pollMs; polls at t=0, 15000, 30000 (>= window) -> 3 looks
    expect(calls).toBe(3);
  });
});
