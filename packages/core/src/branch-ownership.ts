/**
 * A PR-less `issue/<n>-*` branch is reset-and-retried only when it is provably
 * fixowl's own interrupted work (issue #69). The night otherwise force-deletes
 * the remote branch, so without this gate a human's hand-pushed `issue/<n>-*`
 * branch (or a third-party adopter's branch) would be deleted overnight - a
 * data-loss footgun inside the trust boundary. Ownership is decided from the
 * branch tip alone, with two independent signals, either sufficient.
 */

/** The commit identity fixowl commits under (git-ops.ts::configureIdentity). */
export const FIXOWL_BOT_EMAIL = "fixowl-bot@users.noreply.github.com";

/** The tip commit of a remote branch, as read for the ownership check. */
export interface CommitTip {
  /** Author email (`git log --format=%ae`). */
  authorEmail: string;
  /** Subject line (`git log --format=%s`). */
  subject: string;
}

/** fixowl's one-commit subject trailer for issue <n> (pr-body.ts::buildPrTitle). */
export function fixowlCommitTrailer(issueNumber: number): string {
  return `fix #${issueNumber}:`;
}

/**
 * Whether a PR-less `issue/<n>-*` branch tip is provably fixowl's own work and
 * may therefore be reset and retried. Two independent signals, either enough:
 *  - the tip commit author email is fixowl's bot identity, or
 *  - the tip subject starts with fixowl's commit trailer `fix #<n>:`.
 * A branch a human or third party pushed matches neither and is preserved.
 */
export function isFixowlBranchTip(tip: CommitTip, issueNumber: number): boolean {
  if (tip.authorEmail.trim().toLowerCase() === FIXOWL_BOT_EMAIL) return true;
  return tip.subject.trimStart().startsWith(fixowlCommitTrailer(issueNumber));
}
