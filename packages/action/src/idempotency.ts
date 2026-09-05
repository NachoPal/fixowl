import { issueBranchPrefix } from "@fixowl/core";
import type { IssueLite } from "./deps.ts";

export interface IdempotencyResult {
  selected: IssueLite[];
  skipped: Array<{ issue: IssueLite; branch: string }>;
}

/**
 * A remote `issue/<n>-*` branch marks an issue as "already touched": every issue
 * whose branch exists is returned in `skipped`. Whether that branch is genuinely
 * *attempted* (has an associated PR - open means in review, merged means done,
 * closed-unmerged means deliberately abandoned) or is *orphaned* interrupted
 * work (pushed, then interrupted before the PR opened) is resolved by the caller
 * via a per-branch PR lookup: an orphaned branch is reset and its issue retried,
 * not stranded (issue #57). Retrying an issue = delete its `issue/<n>-*` branch.
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
