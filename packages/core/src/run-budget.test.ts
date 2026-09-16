import { describe, expect, it } from "vitest";
import type { UsageSnapshot } from "./agent-usage.ts";
import {
  buildStopConditions,
  evaluateBudget,
  type BudgetLimits,
  type BudgetState,
} from "./run-budget.ts";

function state(partial: Partial<BudgetState> = {}): BudgetState {
  return { elapsedMs: 0, usage: undefined, tokensUsed: undefined, ...partial };
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
    expect(buildStopConditions({ usagePercent: 85 }).map((c) => c.name)).toEqual(["usage"]);
    expect(buildStopConditions({ usagePercent: 85, runMinutes: 240 }).map((c) => c.name)).toEqual([
      "usage",
      "wallclock",
    ]);
    expect(
      buildStopConditions({
        usagePercent: 85,
        totalTokens: 3_000_000,
        runMinutes: 240,
      }).map((c) => c.name),
    ).toEqual(["usage", "tokens", "wallclock"]);
  });
});

describe("no count condition", () => {
  it("is not a stop condition at all (issue #82: max_issues_per_run is a selection cap)", () => {
    // A "shipped >= cap" gate could never trip - selection has already sliced the
    // set to the cap - so it is gone. Nothing here knows about an issue count.
    const everyAxis: BudgetLimits = {
      usagePercent: 85,
      totalTokens: 3_000_000,
      runMinutes: 240,
    };
    expect(buildStopConditions(everyAxis).map((c) => String(c.name))).not.toContain("count");
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

describe("tokens condition", () => {
  it("trips once accumulated tokens reach the cap, not before", () => {
    expect(verdict({ totalTokens: 1_000 }, state({ tokensUsed: 999 })).stop).toBe(false);
    const tripped = verdict({ totalTokens: 1_000 }, state({ tokensUsed: 1_000 }));
    expect(tripped.stop).toBe(true);
    if (tripped.stop) {
      expect(tripped.condition).toBe("tokens");
      expect(tripped.reason).toContain("cap 1000");
      expect(tripped.reason).toContain("1000 token(s) spent");
    }
  });

  it("is opted out when totalTokens is undefined", () => {
    expect(verdict({}, state({ tokensUsed: 999_999 })).stop).toBe(false);
  });

  it("abstains (never trips) when spend is unmeasurable", () => {
    // Fail-open like usage: an agent that reports no usage must not stop a run
    // the other caps would allow.
    expect(verdict({ totalTokens: 1 }, state({ tokensUsed: undefined })).stop).toBe(false);
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
  it("reports usage before wall-clock when several trip at once", () => {
    const all: BudgetLimits = { usagePercent: 50, runMinutes: 1 };
    const everything = state({ usage: usage(90), elapsedMs: 60 * 60_000 });
    const v = evaluateBudget(buildStopConditions(all), everything);
    expect(v.stop).toBe(true);
    if (v.stop) expect(v.condition).toBe("usage");
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

  it("reports tokens before wall-clock when usage abstains and both trip", () => {
    // usage enabled but unobservable (abstains); tokens trips and is reported
    // ahead of the also-tripping wall-clock, per the fixed order.
    const v = verdict(
      { usagePercent: 50, totalTokens: 1_000, runMinutes: 1 },
      state({ usage: undefined, tokensUsed: 2_000, elapsedMs: 5 * 60_000 }),
    );
    expect(v.stop).toBe(true);
    if (v.stop) expect(v.condition).toBe("tokens");
  });

  it("does not stop when no condition trips", () => {
    expect(
      verdict(
        { usagePercent: 85, totalTokens: 3_000_000, runMinutes: 240 },
        state({ usage: usage(10), tokensUsed: 1000, elapsedMs: 1000 }),
      ).stop,
    ).toBe(false);
  });
});
