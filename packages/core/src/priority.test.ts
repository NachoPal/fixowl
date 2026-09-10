import { describe, expect, it } from "vitest";
import {
  comparePriority,
  isUnlabeled,
  priorityEnabled,
  priorityLabelsToEnsure,
  priorityRank,
  priorityTiers,
  UNLABELED_TIER,
  type PrioritySettings,
} from "./priority.ts";

const TIERS = ["priority: high", "priority: medium", "priority: low"];
const on = (includeUnlabeled = true): PrioritySettings => ({
  labels: [...TIERS],
  includeUnlabeled,
});
const off: PrioritySettings = { labels: [], includeUnlabeled: true };

describe("priorityEnabled", () => {
  it("is true only when a non-empty label list is configured", () => {
    expect(priorityEnabled(on())).toBe(true);
    expect(priorityEnabled(off)).toBe(false);
  });
});

describe("priorityTiers", () => {
  it("appends the unlabeled sentinel as the lowest tier when included", () => {
    expect(priorityTiers(on(true))).toEqual([...TIERS, UNLABELED_TIER]);
  });
  it("omits the unlabeled sentinel when not included", () => {
    expect(priorityTiers(on(false))).toEqual([...TIERS]);
  });
  it("is empty when the feature is off", () => {
    expect(priorityTiers(off)).toEqual([]);
  });
});

describe("priorityRank", () => {
  it("ranks by the first configured label carried, highest = 0", () => {
    expect(priorityRank(["priority: high", "bug"], on())).toBe(0);
    expect(priorityRank(["priority: medium"], on())).toBe(1);
    expect(priorityRank(["priority: low"], on())).toBe(2);
  });
  it("ranks an un-prioritized issue at labels.length (the unlabeled tier)", () => {
    expect(priorityRank(["bug"], on())).toBe(3);
  });
  it("uses the earliest tier when several priority labels are present", () => {
    expect(priorityRank(["priority: low", "priority: high"], on())).toBe(0);
  });
  it("ranks every issue equal when the feature is off", () => {
    expect(priorityRank(["priority: high"], off)).toBe(0);
    expect(priorityRank(["bug"], off)).toBe(0);
  });
});

describe("isUnlabeled", () => {
  it("is true only when none of the configured priority labels are present", () => {
    expect(isUnlabeled(["bug", "for: agent"], on())).toBe(true);
    expect(isUnlabeled(["priority: low"], on())).toBe(false);
  });
});

describe("comparePriority", () => {
  it("orders by rank first, then oldest-first (issue number)", () => {
    const high = { number: 90, labels: ["priority: high"] };
    const medOld = { number: 10, labels: ["priority: medium"] };
    const medNew = { number: 20, labels: ["priority: medium"] };
    const settings = on();
    expect(comparePriority(high, medOld, settings)).toBeLessThan(0); // high before medium
    expect(comparePriority(medOld, medNew, settings)).toBeLessThan(0); // same tier -> oldest first
    expect(comparePriority(medNew, medOld, settings)).toBeGreaterThan(0);
  });
  it("sorts a mixed list high-first then oldest-first within a tier", () => {
    const issues = [
      { number: 5, labels: ["bug"] }, // unlabeled -> lowest
      { number: 30, labels: ["priority: high"] },
      { number: 12, labels: ["priority: medium"] },
      { number: 8, labels: ["priority: high"] },
    ];
    const sorted = issues.toSorted((a, b) => comparePriority(a, b, on()));
    expect(sorted.map((i) => i.number)).toEqual([8, 30, 12, 5]);
  });
  it("falls back to pure oldest-first when the feature is off", () => {
    const a = { number: 20, labels: ["priority: low"] };
    const b = { number: 10, labels: ["priority: high"] };
    // Off: ranks equal, so lower number wins regardless of priority label.
    expect(comparePriority(a, b, off)).toBeGreaterThan(0);
  });
});

describe("priorityLabelsToEnsure", () => {
  it("returns the configured labels in tier order", () => {
    expect(priorityLabelsToEnsure(on())).toEqual([...TIERS]);
    expect(priorityLabelsToEnsure(off)).toEqual([]);
  });
});
