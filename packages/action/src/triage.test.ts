import { describe, expect, it } from "vitest";
import type { IssueLite, IssueTriageSignals } from "./deps.ts";
import { DUPLICATE_LABEL, planTriage, TRIAGED_LABEL, triageComment } from "./triage.ts";

function issue(number: number, labels: string[] = ["overnight"]): IssueLite {
  return { number, title: `#${number}`, body: "x", labels };
}

function signals(entries: Record<number, IssueTriageSignals>): Map<number, IssueTriageSignals> {
  return new Map(Object.entries(entries).map(([n, s]) => [Number(n), s]));
}

const bothOn = { skipAlreadyFixed: true, skipDuplicates: true };

describe("planTriage", () => {
  it("skips an issue GitHub records as fixed by a closing-keyword-linked merged PR", () => {
    const plan = planTriage(
      [issue(1), issue(2)],
      signals({ 1: { number: 1, fixedByMergedPr: { number: 51, url: "u/51" } } }),
      bothOn,
    );
    expect(plan.work.map((i) => i.number)).toEqual([2]);
    expect(plan.triaged).toHaveLength(1);
    expect(plan.triaged[0]).toMatchObject({
      layer: "gate",
      category: "already-fixed",
      ref: { number: 51, url: "u/51" },
    });
  });

  it("skips an issue GitHub records as a duplicate, linking the canonical", () => {
    const plan = planTriage(
      [issue(1)],
      signals({ 1: { number: 1, duplicateOf: { number: 9, url: "u/9" } } }),
      bothOn,
    );
    expect(plan.work).toHaveLength(0);
    expect(plan.triaged[0]).toMatchObject({
      category: "duplicate",
      ref: { number: 9, url: "u/9" },
    });
  });

  it("skips an issue carrying the `duplicate` label even with no GraphQL signal", () => {
    const plan = planTriage([issue(1, ["overnight", DUPLICATE_LABEL])], new Map(), bothOn);
    expect(plan.work).toHaveLength(0);
    expect(plan.triaged[0]).toMatchObject({ category: "duplicate", ref: undefined });
  });

  it("does NOT skip a bare merged-PR cross-reference (the #136 false-positive trap)", () => {
    // A bare cross-reference never becomes `fixedByMergedPr` in the signal, so the
    // gate leaves it for Layer B. This is the load-bearing safety property.
    const plan = planTriage([issue(1)], signals({ 1: { number: 1 } }), bothOn);
    expect(plan.work.map((i) => i.number)).toEqual([1]);
    expect(plan.triaged).toHaveLength(0);
  });

  it("does not skip already-fixed when skip_already_fixed is off", () => {
    const plan = planTriage(
      [issue(1)],
      signals({ 1: { number: 1, fixedByMergedPr: { number: 51, url: "u/51" } } }),
      { skipAlreadyFixed: false, skipDuplicates: true },
    );
    expect(plan.work.map((i) => i.number)).toEqual([1]);
  });

  it("does not skip duplicates when skip_duplicates is off", () => {
    const plan = planTriage([issue(1, ["overnight", DUPLICATE_LABEL])], new Map(), {
      skipAlreadyFixed: true,
      skipDuplicates: false,
    });
    expect(plan.work.map((i) => i.number)).toEqual([1]);
  });

  it("passes everything through when there are no signals", () => {
    const plan = planTriage([issue(1), issue(2), issue(3)], new Map(), bothOn);
    expect(plan.work).toHaveLength(3);
    expect(plan.triaged).toHaveLength(0);
  });

  it("prefers the duplicate verdict over already-fixed when both signals are present", () => {
    const plan = planTriage(
      [issue(1)],
      signals({
        1: {
          number: 1,
          fixedByMergedPr: { number: 51, url: "u/51" },
          duplicateOf: { number: 9, url: "u/9" },
        },
      }),
      bothOn,
    );
    expect(plan.triaged[0]?.category).toBe("duplicate");
  });
});

describe("triageComment", () => {
  it("links the fixing PR and names the re-arm label for an already-fixed skip", () => {
    const body = triageComment({
      issue: issue(1),
      layer: "gate",
      category: "already-fixed",
      ref: { number: 51, url: "https://x/pull/51" },
    });
    expect(body).toContain("https://x/pull/51");
    expect(body).toContain(TRIAGED_LABEL);
    expect(body).toContain("no PR");
  });

  it("includes the agent explanation for an already-implemented skip", () => {
    const body = triageComment({
      issue: issue(1),
      layer: "agent",
      category: "already-implemented",
      explanation: "the flag already defaults to true in config.ts",
    });
    expect(body).toContain("already implemented");
    expect(body).toContain("the flag already defaults to true");
  });
});
