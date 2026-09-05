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

  it("is green immediately when there is no CI at all (unreadable + no checks)", async () => {
    const github = new FakeGitHub([issue(1, "t")]);
    github.checksForRef = () => [];
    const result = await waitForRequiredChecks(
      { github, log: silentLog, clock: fakeClock() },
      { sha: "sha", base: "main", required: { readable: false, contexts: [] }, timeoutMs: 600_000 },
    );
    expect(result.outcome).toBe("green");
  });
});
