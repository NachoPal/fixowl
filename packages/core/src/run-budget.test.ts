import { describe, expect, it } from "vitest";
import type { UsageSnapshot } from "./agent-usage.ts";
import {
  buildStopConditions,
  evaluateBudget,
  type BudgetLimits,
  type BudgetState,
} from "./run-budget.ts";

function state(partial: Partial<BudgetState> = {}): BudgetState {
  return { shipped: 0, elapsedMs: 0, usage: undefined, ...partial };
}

function usage(usedPercent: number, limiting = "five_hour"): UsageSnapshot {
  return {
    usedPercent,
    limiting,
    windows: { [limiting]: { usedPercent, resetsAt: 0 } },
  };
}

function verdict(limits: BudgetLimits, s: BudgetState) {
  return evaluateBudget(buildStopConditions(limits), s);
}

describe("buildStopConditions", () => {
  it("includes only the conditions whose limit is set", () => {
    expect(buildStopConditions({}).map((c) => c.name)).toEqual([]);
    expect(buildStopConditions({ maxIssues: 4 }).map((c) => c.name)).toEqual(["count"]);
    expect(
      buildStopConditions({ maxIssues: 4, usagePercent: 85, runMinutes: 240 }).map((c) => c.name),
    ).toEqual(["count", "usage", "wallclock"]);
  });
});

describe("count condition", () => {
  it("trips once shipped reaches the cap, not before", () => {
    expect(verdict({ maxIssues: 2 }, state({ shipped: 1 })).stop).toBe(false);
    const tripped = verdict({ maxIssues: 2 }, state({ shipped: 2 }));
    expect(tripped.stop).toBe(true);
    if (tripped.stop) {
      expect(tripped.condition).toBe("count");
      expect(tripped.reason).toContain("cap 2");
    }
  });

  it("is opted out when maxIssues is undefined", () => {
    expect(verdict({}, state({ shipped: 999 })).stop).toBe(false);
  });
});

describe("usage condition", () => {
  it("trips at or above the budget percent", () => {
    expect(verdict({ usagePercent: 85 }, state({ usage: usage(84.9) })).stop).toBe(false);
    const tripped = verdict({ usagePercent: 85 }, state({ usage: usage(85) }));
    expect(tripped.stop).toBe(true);
    if (tripped.stop) {
      expect(tripped.condition).toBe("usage");
      expect(tripped.reason).toContain("five_hour");
      expect(tripped.reason).toContain("85%");
    }
  });

  it("reports the limiting window and a clean percent", () => {
    const tripped = verdict({ usagePercent: 80 }, state({ usage: usage(91.37, "seven_day") }));
    expect(tripped.stop).toBe(true);
    if (tripped.stop) {
      expect(tripped.reason).toContain("seven_day window at 91.4%");
    }
  });

  it("abstains (never trips) when usage is unobservable", () => {
    // The flagship's fail-open posture: an unreadable window must not stop a run
    // the other caps would allow.
    expect(verdict({ usagePercent: 1 }, state({ usage: undefined })).stop).toBe(false);
  });
});

describe("wall-clock condition", () => {
  it("trips once elapsed reaches the budget minutes", () => {
    expect(verdict({ runMinutes: 10 }, state({ elapsedMs: 9 * 60_000 })).stop).toBe(false);
    const tripped = verdict({ runMinutes: 10 }, state({ elapsedMs: 10 * 60_000 }));
    expect(tripped.stop).toBe(true);
    if (tripped.stop) {
      expect(tripped.condition).toBe("wallclock");
      expect(tripped.reason).toContain("budget 10 min");
    }
  });
});

describe("first-to-trip ordering", () => {
  it("reports count before usage before wall-clock when several trip at once", () => {
    const all: BudgetLimits = { maxIssues: 1, usagePercent: 50, runMinutes: 1 };
    const everything = state({ shipped: 5, usage: usage(90), elapsedMs: 60 * 60_000 });
    const v = evaluateBudget(buildStopConditions(all), everything);
    expect(v.stop).toBe(true);
    if (v.stop) expect(v.condition).toBe("count");
  });

  it("skips an abstaining earlier condition and reports the next that trips", () => {
    // usage is enabled but unobservable (abstains); wall-clock trips and is reported.
    const v = verdict(
      { usagePercent: 50, runMinutes: 1 },
      state({ usage: undefined, elapsedMs: 5 * 60_000 }),
    );
    expect(v.stop).toBe(true);
    if (v.stop) expect(v.condition).toBe("wallclock");
  });

  it("does not stop when no condition trips", () => {
    expect(
      verdict(
        { maxIssues: 4, usagePercent: 85, runMinutes: 240 },
        state({ shipped: 1, usage: usage(10), elapsedMs: 1000 }),
      ).stop,
    ).toBe(false);
  });
});
