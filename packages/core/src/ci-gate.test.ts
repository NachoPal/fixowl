import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  failedChecks,
  gatingChecks,
  isFailureConclusion,
  type CheckStatusLite,
  type RequiredChecks,
} from "./ci-gate.ts";

const check = (over: Partial<CheckStatusLite> & { name: string }): CheckStatusLite => ({
  status: "completed",
  conclusion: "success",
  ...over,
});

const readable = (contexts: string[]): RequiredChecks => ({ readable: true, contexts });
const unreadable: RequiredChecks = { readable: false, contexts: [] };

describe("isFailureConclusion", () => {
  it("treats success/neutral/skipped as passing and the rest as failures", () => {
    expect(isFailureConclusion("success")).toBe(false);
    expect(isFailureConclusion("neutral")).toBe(false);
    expect(isFailureConclusion("skipped")).toBe(false);
    expect(isFailureConclusion(null)).toBe(false);
    expect(isFailureConclusion("failure")).toBe(true);
    expect(isFailureConclusion("timed_out")).toBe(true);
    expect(isFailureConclusion("cancelled")).toBe(true);
    expect(isFailureConclusion("action_required")).toBe(true);
  });
});

describe("gatingChecks", () => {
  it("filters to the required contexts when readable", () => {
    const all = [check({ name: "ci" }), check({ name: "lint" })];
    const gating = gatingChecks(all, readable(["ci"]));
    expect(gating.usedFallback).toBe(false);
    expect(gating.checks.map((c) => c.name)).toEqual(["ci"]);
  });

  it("gates on all checks when the required set is unreadable", () => {
    const all = [check({ name: "ci" }), check({ name: "lint" })];
    const gating = gatingChecks(all, unreadable);
    expect(gating.usedFallback).toBe(true);
    expect(gating.checks.map((c) => c.name)).toEqual(["ci", "lint"]);
  });
});

describe("evaluateGate (readable required set)", () => {
  it("is pending until every required context is present and completed", () => {
    const required = readable(["ci", "e2e"]);
    // e2e has not appeared yet
    expect(evaluateGate(gatingChecks([check({ name: "ci" })], required), required)).toBe("pending");
    // e2e present but still running
    const running = [
      check({ name: "ci" }),
      check({ name: "e2e", status: "in_progress", conclusion: null }),
    ];
    expect(evaluateGate(gatingChecks(running, required), required)).toBe("pending");
  });

  it("is green when every required context completed non-failing", () => {
    const required = readable(["ci", "e2e"]);
    const all = [check({ name: "ci" }), check({ name: "e2e", conclusion: "neutral" })];
    expect(evaluateGate(gatingChecks(all, required), required)).toBe("green");
  });

  it("is failed when a required context completed red", () => {
    const required = readable(["ci"]);
    const all = [check({ name: "ci", conclusion: "failure" })];
    expect(evaluateGate(gatingChecks(all, required), required)).toBe("failed");
  });

  it("ignores non-required checks entirely", () => {
    const required = readable(["ci"]);
    const all = [check({ name: "ci" }), check({ name: "lint", conclusion: "failure" })];
    expect(evaluateGate(gatingChecks(all, required), required)).toBe("green");
  });
});

describe("evaluateGate (fallback / unreadable required set)", () => {
  it("is green on an empty check set (nothing to gate on)", () => {
    expect(evaluateGate(gatingChecks([], unreadable), unreadable)).toBe("green");
  });

  it("waits while any check is still running", () => {
    const all = [check({ name: "ci", status: "in_progress", conclusion: null })];
    expect(evaluateGate(gatingChecks(all, unreadable), unreadable)).toBe("pending");
  });

  it("is failed when any completed check is red", () => {
    const all = [check({ name: "ci" }), check({ name: "lint", conclusion: "failure" })];
    expect(evaluateGate(gatingChecks(all, unreadable), unreadable)).toBe("failed");
  });
});

describe("failedChecks", () => {
  it("returns only the completed, failing checks", () => {
    const all = [
      check({ name: "ci", conclusion: "failure" }),
      check({ name: "e2e", status: "in_progress", conclusion: null }),
      check({ name: "lint" }),
    ];
    expect(failedChecks(gatingChecks(all, unreadable)).map((c) => c.name)).toEqual(["ci"]);
  });
});
