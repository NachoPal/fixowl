/**
 * Branch naming is the idempotency backbone: one branch `issue/<n>-<slug>` per
 * issue, and the existence of any `issue/<n>-*` branch means issue <n> has been
 * attempted and must not be retried until that branch is deleted.
 */

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "untitled" : slug;
}

export function issueBranchName(issueNumber: number, title: string): string {
  return `issue/${issueNumber}-${slugify(title)}`;
}

/** Prefix that identifies branches for one issue; the trailing dash keeps issue 12 from matching issue 123. */
export function issueBranchPrefix(issueNumber: number): string {
  return `issue/${issueNumber}-`;
}

export function issueNumberFromBranch(branch: string): number | null {
  const match = /^issue\/(\d+)-/.exec(branch);
  return match ? Number(match[1]) : null;
}
