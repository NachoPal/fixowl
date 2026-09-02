import { issueBranchPrefix } from "@fixowl/core";
import type { IssueLite } from "./deps.ts";

export interface IdempotencyResult {
  selected: IssueLite[];
  skipped: Array<{ issue: IssueLite; branch: string }>;
}

/**
 * The remote branch is the single source of truth for "already attempted":
 * open PR means in review, merged means done, closed-unmerged means
 * deliberately abandoned. Retrying an issue = delete its `issue/<n>-*` branch.
 */
export function filterAlreadyAttempted(
  issues: readonly IssueLite[],
  remoteBranches: readonly string[],
): IdempotencyResult {
  const selected: IssueLite[] = [];
  const skipped: Array<{ issue: IssueLite; branch: string }> = [];
  for (const issue of issues) {
    const prefix = issueBranchPrefix(issue.number);
    const existing = remoteBranches.find((branch) => branch.startsWith(prefix));
    if (existing !== undefined) {
      skipped.push({ issue, branch: existing });
    } else {
      selected.push(issue);
    }
  }
  return { selected, skipped };
}
