import { describe, expect, it } from "vitest";
import { mergeGraphs } from "./merge-graph.ts";

function prereqs(entries: Record<number, number[]>): Map<number, number[]> {
  return new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));
}

describe("mergeGraphs", () => {
  it("returns the LLM chains unchanged when there are no prereq edges (regression guard)", () => {
    const chains = [[15, 12], [3], [7, 8, 9]];
    expect(mergeGraphs(chains, prereqs({}))).toEqual([[15, 12], [3], [7, 8, 9]]);
  });

  it("reorders a conflict group to respect a prereq (prereq order wins)", () => {
    // LLM said fix 2 then 1, but 1 is a prerequisite of 2.
    expect(mergeGraphs([[2, 1]], prereqs({ 2: [1] }))).toEqual([[1, 2]]);
  });

  it("forces prereq-linked issues to stack even when the LLM called them independent", () => {
    expect(mergeGraphs([[1], [2]], prereqs({ 2: [1] }))).toEqual([[1, 2]]);
  });

  it("preserves the LLM order within a chain that carries no prereq edge", () => {
    // Two separate conflict groups, a prereq only inside the second.
    expect(
      mergeGraphs(
        [
          [5, 4],
          [2, 3],
        ],
        prereqs({ 3: [2] }),
      ),
    ).toEqual([
      [5, 4],
      [2, 3],
    ]);
  });

  it("merges a conflict group and a prereq chain that share an issue", () => {
    // LLM: {1,2} same files, {3} alone. Prereq 3 -> 2 pulls 3 into the group.
    const merged = mergeGraphs([[1, 2], [3]], prereqs({ 3: [2] }));
    expect(merged).toHaveLength(1);
    // 2 must precede 3; 1 keeps its LLM position ahead of 2.
    expect(merged[0]).toEqual([1, 2, 3]);
  });

  it("keeps component order stable by first LLM position", () => {
    const merged = mergeGraphs([[10], [20], [30]], prereqs({ 30: [10] }));
    // 10 and 30 merge (10 first by position); 20 stays its own group after it.
    expect(merged).toEqual([[10, 30], [20]]);
  });
});
