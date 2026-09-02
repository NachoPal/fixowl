import { issueMatchesLabelRule, labelQueriesForRule, type LabelRule } from "@fixowl/core";
import type { GitHubApi, IssueLite } from "./deps.ts";

/**
 * Selects the open issues matching the label rule, oldest first. `any` rules
 * need one list call per label (the GitHub labels parameter is AND); results
 * are unioned by number and re-filtered client-side, which also covers the
 * combined any+all case.
 */
export async function selectIssues(github: GitHubApi, rule: LabelRule): Promise<IssueLite[]> {
  const byNumber = new Map<number, IssueLite>();
  for (const query of labelQueriesForRule(rule)) {
    for (const issue of await github.listOpenIssuesWithLabels(query)) {
      byNumber.set(issue.number, issue);
    }
  }
  return [...byNumber.values()]
    .filter((issue) => issueMatchesLabelRule(issue.labels, rule))
    .toSorted((a, b) => a.number - b.number);
}
