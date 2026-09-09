/**
 * A PR-less `issue/<n>-*` branch is reset-and-retried only when it is provably
 * fixowl's own interrupted work (issue #69). The night otherwise force-deletes
 * the remote branch, so without this gate a human's hand-pushed `issue/<n>-*`
 * branch (or a third-party adopter's branch) would be deleted overnight - a
 * data-loss footgun inside the trust boundary. Ownership is decided from the
 * branch tip alone, with two independent signals, either sufficient.
 */

/**
 * The legacy no-reply email fixowl authored commits under before it resolved the
 * installed App's real bot identity at runtime (git-ops.ts::configureIdentity).
 * Kept as a recognized-legacy ownership signal: branches pushed by older fixowl
 * versions must still be recognized as fixowl's own work even after the author
 * email changes to the App bot identity.
 */
export const FIXOWL_BOT_EMAIL = "fixowl-bot@users.noreply.github.com";

/** A git author/committer identity (`user.name` / `user.email`). */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * The fallback commit identity used when the App bot identity cannot be resolved
 * at runtime (a network/read failure must never abort the night over a cosmetic
 * identity read). It matches the legacy email, so a branch authored under the
 * fallback is still recognized by `isFixowlBranchTip`.
 */
export const FIXOWL_DEFAULT_GIT_IDENTITY: GitIdentity = {
  name: "fixowl",
  email: FIXOWL_BOT_EMAIL,
};

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
 *  - the tip commit author email is a recognized fixowl bot identity, or
 *  - the tip subject starts with fixowl's commit trailer `fix #<n>:`.
 * A branch a human or third party pushed matches neither and is preserved.
 *
 * The email signal is App-identity-aware: it accepts both the resolved App bot
 * no-reply email of the currently installed App (`appBotEmail`, e.g.
 * `<id>+<slug>[bot]@users.noreply.github.com`) AND the legacy
 * `fixowl-bot@users.noreply.github.com`, so branches pushed by older fixowl
 * versions - which authored under the legacy email - stay recognized in a
 * mixed-version repo. The `fix #<n>:` subject signal is the safety net that
 * matches every fixowl commit regardless of author email.
 */
export function isFixowlBranchTip(
  tip: CommitTip,
  issueNumber: number,
  appBotEmail?: string,
): boolean {
  const email = tip.authorEmail.trim().toLowerCase();
  if (email === FIXOWL_BOT_EMAIL) return true;
  if (appBotEmail !== undefined && email === appBotEmail.trim().toLowerCase()) return true;
  return tip.subject.trimStart().startsWith(fixowlCommitTrailer(issueNumber));
}
