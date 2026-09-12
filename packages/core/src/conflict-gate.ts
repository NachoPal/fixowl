/**
 * Pure decision logic for the CI-gated loop's conflict awareness. A fixowl PR
 * goes *dirty* (GitHub `mergeable_state: "dirty"`) when the base branch advances
 * under it with a conflicting change - the night branches from the `origin/main`
 * it fetched, and main can move on while a long (or long-queued) night runs. For
 * a dirty PR GitHub cannot build the pull-request merge ref, so the
 * `pull_request`-triggered required checks never register or complete: the CI
 * gate would otherwise wait out its whole timeout, retry the agent, and re-wait
 * on an unchanged head - burning `ci_max_tries x ci_timeout` on checks that can
 * never go green (the issue this module fixes).
 *
 * This module has no I/O: it maps a PR's mergeability to what the loop should do.
 * The GitHub read and the poll-until-known live at the edges (ci-poll.ts,
 * github-api.ts); the rebase mechanics live on the host (git-ops.ts).
 */

/**
 * What the CI gate should do given a PR's mergeability:
 *  - `proceed`  the PR is clean (or a non-conflict state GitHub's own required
 *               check handles - `behind`/`blocked`/`unstable`), so wait on CI as usual.
 *  - `rebase`   the PR conflicts (`dirty`): rebase onto the current base and
 *               re-run the agent to resolve, or - if that fails - surface the
 *               conflict distinctly instead of masquerading as a CI wait.
 *  - `unknown`  GitHub has not finished computing mergeability (`mergeable: null`);
 *               the caller polls, then falls open to `proceed` so an unknowable
 *               state never blocks the night.
 */
export type ConflictAction = "proceed" | "rebase" | "unknown";

/**
 * Decide from a PR's mergeability whether the gate may proceed, a rebase is
 * needed, or GitHub has not computed it yet.
 *
 * Only `dirty` (real merge conflicts) triggers a rebase. `behind` (the base
 * moved but there is no conflict, common under a strict required-checks policy)
 * is deliberately NOT a rebase: GitHub's own "out of date" required check
 * handles it, and rebasing for it would be needless churn. `null` mergeability
 * is `unknown` (GitHub still computing) regardless of the `mergeable_state`
 * string, which is often `"unknown"`/`"checking"` in that window.
 */
export function classifyMergeability(mergeable: boolean | null, state: string): ConflictAction {
  if (mergeable === null) return "unknown";
  if (state === "dirty") return "rebase";
  return "proceed";
}
