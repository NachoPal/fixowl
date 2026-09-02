import { describe, expect, it } from "vitest";
import { planChains } from "./chain-planner.ts";
import { issue } from "./test-helpers.ts";

describe("planChains", () => {
  it("maps chain numbers to issues in order", () => {
    const issues = [issue(12, "a"), issue(15, "b"), issue(18, "c")];
    const chains = planChains(issues, [[12], [18, 15]]);
    expect(chains.map((chain) => chain.map((i) => i.number))).toEqual([[12], [18, 15]]);
  });

  it("throws on unknown issue numbers", () => {
    expect(() => planChains([issue(1, "a")], [[2]])).toThrow(/unselected issue #2/);
  });
});
