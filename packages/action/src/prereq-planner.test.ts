import { describe, expect, it } from "vitest";
import type { EdgeRef, IssueDeps } from "./deps.ts";
import { planPrereqs } from "./prereq-planner.ts";
import { issue } from "./test-helpers.ts";

const REPO = "test/repo";

function edge(number: number, state: "OPEN" | "CLOSED" = "OPEN", repo = REPO): EdgeRef {
  return { number, repo, state };
}

function deps(entries: Record<number, Partial<IssueDeps>>): Map<number, IssueDeps> {
  const map = new Map<number, IssueDeps>();
  for (const [number, value] of Object.entries(entries)) {
    const n = Number(number);
    map.set(n, { number: n, blockedBy: [], ...value });
  }
  return map;
}

describe("planPrereqs", () => {
  it("orders a prerequisite before its dependent, overriding oldest-first", () => {
    // #1 is blocked by #9, so #9 must ship first even though it is the newer issue.
    const selected = [issue(1, "dependent"), issue(9, "prerequisite")];
    const plan = planPrereqs(selected, deps({ 1: { blockedBy: [edge(9)] } }), REPO);

    expect(plan.shippable.map((i) => i.number)).toEqual([9, 1]);
    expect(plan.prereqs.get(1)).toEqual([9]);
    expect(plan.deferred).toEqual([]);
  });

  it("with no edges leaves the set in oldest-first order and defers nothing", () => {
    const selected = [issue(1, "a"), issue(2, "b"), issue(3, "c")];
    const plan = planPrereqs(selected, deps({}), REPO);

    expect(plan.shippable.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(plan.deferred).toEqual([]);
    expect([...plan.prereqs.values()].every((p) => p.length === 0)).toBe(true);
  });

  it("defers a dependent whose blocker is not in tonight's set", () => {
    const selected = [issue(2, "dependent")];
    const plan = planPrereqs(selected, deps({ 2: { blockedBy: [edge(1)] } }), REPO);

    expect(plan.shippable).toEqual([]);
    expect(plan.deferred.map((d) => d.issue.number)).toEqual([2]);
    expect(plan.deferred[0]?.reason).toContain("#1");
  });

  it("treats a closed blocker as satisfied", () => {
    const selected = [issue(2, "dependent")];
    const plan = planPrereqs(selected, deps({ 2: { blockedBy: [edge(1, "CLOSED")] } }), REPO);

    expect(plan.shippable.map((i) => i.number)).toEqual([2]);
    expect(plan.deferred).toEqual([]);
    expect(plan.prereqs.get(2)).toEqual([]);
  });

  it("defers a dependent blocked by an issue in another repo", () => {
    const selected = [issue(2, "dependent")];
    const plan = planPrereqs(
      selected,
      deps({ 2: { blockedBy: [edge(1, "OPEN", "other/repo")] } }),
      REPO,
    );

    expect(plan.shippable).toEqual([]);
    expect(plan.deferred[0]?.reason).toContain("other/repo");
  });

  it("cascades deferral to a dependent of a deferred issue", () => {
    // #3 -> #2 (in set), #2 -> #1 (absent). #2 defers on the absent blocker; #3 cascades.
    const selected = [issue(2, "middle"), issue(3, "leaf")];
    const plan = planPrereqs(
      selected,
      deps({ 2: { blockedBy: [edge(1)] }, 3: { blockedBy: [edge(2)] } }),
      REPO,
    );

    expect(plan.shippable).toEqual([]);
    expect(plan.deferred.map((d) => d.issue.number).toSorted()).toEqual([2, 3]);
    const three = plan.deferred.find((d) => d.issue.number === 3);
    expect(three?.reason).toContain("#2");
  });

  it("defers the whole cycle and warns, emitting no order for it", () => {
    // #1 <-> #2 cycle, #3 independent and shippable.
    const selected = [issue(1, "a"), issue(2, "b"), issue(3, "c")];
    const plan = planPrereqs(
      selected,
      deps({ 1: { blockedBy: [edge(2)] }, 2: { blockedBy: [edge(1)] } }),
      REPO,
    );

    expect(plan.shippable.map((i) => i.number)).toEqual([3]);
    expect(plan.deferred.map((d) => d.issue.number).toSorted()).toEqual([1, 2]);
    expect(plan.warnings.some((w) => w.includes("cycle"))).toBe(true);
  });

  it("conservatively defers an issue with more blockers than could be read", () => {
    const selected = [issue(2, "dependent")];
    const plan = planPrereqs(
      selected,
      deps({ 2: { blockedBy: [], blockedByOverflow: true } }),
      REPO,
    );

    expect(plan.shippable).toEqual([]);
    expect(plan.deferred[0]?.reason).toContain("50");
  });
});
