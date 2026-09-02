import type { IssueLite } from "./deps.ts";

/**
 * Turns classification chains into ordered work: each chain is executed in
 * order, each member branching off (and its PR targeting) the branch of the
 * nearest EARLIER chain member that succeeded; a failed member is skipped
 * over, and with no successful parent the member bases on the default branch.
 * Independent issues are singleton chains.
 */
export function planChains(
  issues: readonly IssueLite[],
  chains: readonly (readonly number[])[],
): IssueLite[][] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  return chains.map((chain) =>
    chain.map((issueNumber) => {
      const issue = byNumber.get(issueNumber);
      if (!issue) throw new Error(`chain references unselected issue #${issueNumber}`);
      return issue;
    }),
  );
}
