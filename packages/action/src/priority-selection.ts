import {
  isUnlabeled,
  issueMatchesLabelRule,
  labelQueriesForRule,
  priorityTiers,
  UNLABELED_TIER,
  type LabelRule,
  type PrioritySettings,
} from "@fixowl/core";
import type { IssueLite } from "./deps.ts";

/**
 * Bounded, priority-first issue selection (the I/O orchestrator; the pure ranking
 * lives in @fixowl/core priority.ts). Pages each priority tier highest-first and
 * routes every fetched page through `keepEligible` (the branch-idempotency filter
 * + the Layer-A triage gate, shared with the non-priority path in main.ts),
 * accumulating survivors until the cap is filled or every tier is exhausted. The
 * fetch is O(cap), never the whole backlog - the whole point of the feature.
 *
 * Tier order = precedence: take as many highest-priority survivors as fit, then
 * the next tier, down to an optional final "unlabeled" tier for issues carrying no
 * priority label (so nothing is starved). "Prerequisites always win" is NOT decided
 * here - priority only chooses WHICH issues are selected; Layer 1 (prereq-planner)
 * keeps ordering authority over `blocked_by` edges. See docs/priority-selection.md.
 */

export interface SelectByPriorityParams {
  /** The pickup label rule (its queries compose with each tier label as an AND). */
  rule: LabelRule;
  /** Resolved priority settings; caller guarantees it is enabled (non-empty labels). */
  priority: PrioritySettings;
  /** The run cap (`max_issues_per_run`); also the page size. */
  maxIssues: number;
  /**
   * One bounded page for a labels AND-query, oldest-first (the `listOpenIssuesPage`
   * edge). `issues` are the PR-filtered survivors; `fetched` is the RAW page size
   * (issues + PRs) GitHub returned - the exhaustion signal, since a PR intermixed
   * into a full page shortens `issues` without draining the query.
   */
  fetchPage: (
    labelsQuery: string,
    page: number,
    perPage: number,
  ) => Promise<{ issues: IssueLite[]; fetched: number }>;
  /**
   * Reduce a fetched page to the issues that actually get a slot: the branch
   * filter (drops attempted / resets orphaned) and the Layer-A triage gate, both
   * shared with the non-priority path. Runs once per page (a small batch), never
   * over the whole backlog. Side effects (skip logging, triage comment + label)
   * are the caller's; this returns only the survivors, in input order.
   */
  keepEligible: (candidates: IssueLite[]) => Promise<IssueLite[]>;
}

export async function selectIssuesByPriority(params: SelectByPriorityParams): Promise<IssueLite[]> {
  const { rule, priority, maxIssues, fetchPage, keepEligible } = params;
  // GitHub caps per_page at 100; clamp so page offsets stay aligned with what the
  // API actually returns (a requested perPage > 100 would never yield a "full" page).
  const perPage = Math.min(Math.max(1, maxIssues), 100);
  const pickupQueries = labelQueriesForRule(rule);
  const tiers = priorityTiers(priority);

  const selected: IssueLite[] = [];
  // Dedup across tiers and across an `any` rule's multiple pickup queries, so an
  // issue matched by more than one query is only ever considered (and counted) once.
  const seen = new Set<number>();

  for (const tier of tiers) {
    if (selected.length >= maxIssues) break;
    for (const pickup of pickupQueries) {
      if (selected.length >= maxIssues) break;
      const labelsQuery = tier === UNLABELED_TIER ? pickup : `${pickup},${tier}`;
      let page = 1;
      for (;;) {
        const { issues: rawPage, fetched } = await fetchPage(labelsQuery, page, perPage);
        if (fetched === 0) break; // query exhausted
        // Re-filter with the full rule (covers the combined any+all case, like
        // selectIssues), drop already-seen numbers, and for the unlabeled tier
        // keep only issues carrying NONE of the configured priority labels.
        const candidates = rawPage.filter(
          (issue) =>
            !seen.has(issue.number) &&
            issueMatchesLabelRule(issue.labels, rule) &&
            (tier !== UNLABELED_TIER || isUnlabeled(issue.labels, priority)),
        );
        for (const issue of candidates) seen.add(issue.number);
        const survivors = await keepEligible(candidates);
        for (const issue of survivors) {
          selected.push(issue);
          if (selected.length >= maxIssues) break;
        }
        if (selected.length >= maxIssues) break;
        // A short RAW page (fewer items than requested, PRs included) means this
        // query is drained; move to the next query / tier instead of paging past
        // the end. Using the RAW count, not the PR-filtered length, avoids stopping
        // early on a full page that merely happened to carry a PR.
        if (fetched < perPage) break;
        page += 1;
      }
    }
  }
  return selected.slice(0, maxIssues);
}
