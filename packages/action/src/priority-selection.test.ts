import { UNLABELED_TIER, type LabelRule, type PrioritySettings } from "@fixowl/core";
import { describe, expect, it } from "vitest";
import type { IssueLite } from "./deps.ts";
import { selectIssuesByPriority } from "./priority-selection.ts";

const TIERS = ["priority: high", "priority: medium", "priority: low"];
const priorityOn = (includeUnlabeled = true): PrioritySettings => ({
  labels: [...TIERS],
  includeUnlabeled,
});
const rule: LabelRule = { any: ["overnight"] };

function issue(number: number, ...priorityLabels: string[]): IssueLite {
  return { number, title: `#${number}`, body: "", labels: ["overnight", ...priorityLabels] };
}

/**
 * A store keyed by labels AND-query -> the issues carrying every label in it,
 * ordered as given. `fetchPage` slices a bounded page and records every fetch so
 * a test can assert boundedness (page count).
 */
function makeStore(all: IssueLite[]) {
  const fetches: Array<{ labelsQuery: string; page: number; perPage: number }> = [];
  const fetchPage = async (labelsQuery: string, page: number, perPage: number) => {
    fetches.push({ labelsQuery, page, perPage });
    const required = labelsQuery.split(",");
    const matching = all.filter((i) => required.every((label) => i.labels.includes(label)));
    const start = (page - 1) * perPage;
    return matching.slice(start, start + perPage);
  };
  return { fetchPage, fetches };
}

const keepAll = async (candidates: IssueLite[]) => candidates;

describe("selectIssuesByPriority", () => {
  it("fills the cap highest-priority-first, oldest-first within a tier", async () => {
    const all = [
      issue(50, "priority: low"),
      issue(10, "priority: high"),
      issue(30, "priority: medium"),
      issue(20, "priority: high"),
      issue(40, "priority: medium"),
    ];
    const { fetchPage } = makeStore(all);
    const selected = await selectIssuesByPriority({
      rule,
      priority: priorityOn(),
      maxIssues: 3,
      fetchPage,
      keepEligible: keepAll,
    });
    // high (10, 20) then the oldest medium (30).
    expect(selected.map((i) => i.number)).toEqual([10, 20, 30]);
  });

  it("never fetches lower tiers once the cap is filled (bounded)", async () => {
    const all = [issue(1, "priority: high"), issue(2, "priority: high"), issue(3, "priority: low")];
    const { fetchPage, fetches } = makeStore(all);
    const selected = await selectIssuesByPriority({
      rule,
      priority: priorityOn(),
      maxIssues: 2,
      fetchPage,
      keepEligible: keepAll,
    });
    expect(selected.map((i) => i.number)).toEqual([1, 2]);
    // Only the high tier was ever queried; medium / low / unlabeled untouched.
    expect(fetches.every((f) => f.labelsQuery.includes("priority: high"))).toBe(true);
  });

  it("pages further into a tier when keepEligible trims below the cap", async () => {
    // Six high-tier issues; keepEligible drops the first four (e.g. branch-attempted
    // or triaged), so the loop must page past them to reach the cap of 2.
    const all = [1, 2, 3, 4, 5, 6].map((n) => issue(n, "priority: high"));
    const { fetchPage, fetches } = makeStore(all);
    const dropped = new Set([1, 2, 3, 4]);
    const selected = await selectIssuesByPriority({
      rule,
      priority: priorityOn(),
      maxIssues: 2,
      fetchPage,
      keepEligible: async (candidates) => candidates.filter((i) => !dropped.has(i.number)),
    });
    expect(selected.map((i) => i.number)).toEqual([5, 6]);
    // perPage == maxIssues == 2, so reaching #5,#6 needs pages 1..3 of the high tier.
    const highPages = fetches.filter((f) => f.labelsQuery.includes("priority: high"));
    expect(highPages.map((f) => f.page)).toEqual([1, 2, 3]);
  });

  it("moves to the next tier only when the current tier is exhausted and short", async () => {
    const all = [
      issue(1, "priority: high"),
      issue(2, "priority: medium"),
      issue(3, "priority: low"),
    ];
    const { fetchPage, fetches } = makeStore(all);
    const selected = await selectIssuesByPriority({
      rule,
      priority: priorityOn(),
      maxIssues: 3,
      fetchPage,
      keepEligible: keepAll,
    });
    expect(selected.map((i) => i.number)).toEqual([1, 2, 3]);
    // A short page (1 < perPage 3) exhausts each tier in one fetch, so exactly the
    // three tiers were queried once each - no wasted extra page.
    expect(fetches.map((f) => f.page)).toEqual([1, 1, 1]);
  });

  it("works the unlabeled tier last, and only issues carrying no priority label", async () => {
    const all = [
      issue(1, "priority: high"),
      issue(2), // un-prioritized
      issue(3), // un-prioritized
    ];
    const { fetchPage } = makeStore(all);
    const selected = await selectIssuesByPriority({
      rule,
      priority: priorityOn(true),
      maxIssues: 3,
      fetchPage,
      keepEligible: keepAll,
    });
    expect(selected.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it("omits un-prioritized issues when include_unlabeled is false", async () => {
    const all = [issue(1, "priority: high"), issue(2), issue(3)];
    const { fetchPage, fetches } = makeStore(all);
    const selected = await selectIssuesByPriority({
      rule,
      priority: priorityOn(false),
      maxIssues: 5,
      fetchPage,
      keepEligible: keepAll,
    });
    expect(selected.map((i) => i.number)).toEqual([1]);
    // The unlabeled sentinel tier was never queried.
    expect(
      fetches.some((f) => f.labelsQuery === UNLABELED_TIER || f.labelsQuery === "overnight"),
    ).toBe(false);
  });

  it("dedups an issue matched by more than one `any` pickup query in a tier", async () => {
    const multiRule: LabelRule = { any: ["overnight", "bug"] };
    const both: IssueLite = {
      number: 7,
      title: "#7",
      body: "",
      labels: ["overnight", "bug", "priority: high"],
    };
    const { fetchPage } = makeStore([both]);
    const selected = await selectIssuesByPriority({
      rule: multiRule,
      priority: priorityOn(),
      maxIssues: 4,
      fetchPage,
      keepEligible: keepAll,
    });
    expect(selected.map((i) => i.number)).toEqual([7]); // once, not twice
  });
});
