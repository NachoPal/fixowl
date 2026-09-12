# CI-gated fix loop

The per-issue runner does not open a PR after a single agent pass. It drives the
target repo's **real CI** as the authority in a bounded fix loop: push the
change, wait for the base branch's required checks on the head SHA, and if they
are red feed the failures back to the agent and try again. It exits only when
the required checks are green (PR flipped to ready-for-review) or the try budget
is spent (a draft PR is left, annotated with the outstanding failures). fixowl
never merges.

The loop lives in `packages/action/src/issue-pipeline.ts::processIssue`; the
pure gate decision is `packages/core/src/ci-gate.ts`, and the poll/wait is
`packages/action/src/ci-poll.ts`.

## The loop

For each of at most `ci_max_tries` passes:

1. **Run the agent.** From the second pass on, the prompt carries the previous
   attempt's failing checks (fenced as untrusted; see below). A hard agent
   failure or timeout ends the run: if no PR was opened yet it stops on the
   agent-failed path, but if a draft PR was already opened on an earlier pass the
   draft is annotated with the last CI state and the error and kept (issue #72) -
   a failure after the PR exists must never strand an unexplained draft, which
   would make the issue count as attempted and be skipped every future night.
2. **Local pre-check.** The `.fixowl.yml` `verify.checks` still run, but only as
   a cheap smoke test: a change that cannot even lint never reaches CI. A failed
   pre-check feeds its output back and retries **without** pushing - no CI spend.
   Because they no longer gate ready-vs-draft, their drift from CI no longer
   matters.
3. **Push and wait for CI.** On the first push a single **draft** PR is created
   and reused across attempts (later pushes just advance its head SHA and
   re-trigger CI, which runs on `pull_request`). fixowl waits up to
   `ci_timeout_minutes` for the required checks on the head SHA.
4. **Green -> ready.** The PR is flipped to ready-for-review and a success
   comment is posted. **A concrete red check ->** the failures are summarized
   back to the agent and the loop continues. Only a real failure the agent can
   act on triggers a retry: a required context that never registered (a
   `paths:`-filtered, `workflow_dispatch`-only, or uninstalled-app check that
   GitHub reports as "Expected" forever) is a distinct **`stalled`** outcome, and
   a bare timeout with nothing red gives the agent no failure to fix - either one
   stops immediately and leaves an annotated draft rather than burning another
   paid pass and the full timeout again (issue #74).

When the budget is exhausted (or the loop stops early on a `stalled`/empty
result), the draft PR is left with its body and an issue comment listing each
failing required check and a link to its run.

While polling for CI, a single transient read error (a 502, `ECONNRESET`, or a
secondary-rate-limit 403) is absorbed and polling continues; the wait gives up
only after several such errors in a row or once the overall timeout elapses, so
one flaky read never strands the pushed draft (issue #73).

## Which checks gate

fixowl gates only on the checks GitHub marks **required** for the PR's base
branch (branch-protection or ruleset required status checks), read via the
branch-rules endpoint. When that is unreadable - no branch protection, or the
App lacks the read scope - fixowl **falls back to gating on all
completed checks** and logs a warning; it never fails loud. Because an empty
fallback poll cannot by itself distinguish "CI has not registered its checks
yet" (common in the seconds right after a push) from "no CI configured", the
loop applies a short **settle window**: a zero-check fallback poll is not
accepted as green until that window elapses with still no checks. Once any check
appears the normal fallback decision applies at once. A repo with no branch
protection and no CI therefore still opens ready-for-review PRs after the settle
window (there is nothing to gate on).

## Conflict handling (dirty PRs)

fixowl branches each issue from the `origin/<default-branch>` tip it has fetched,
and the base can advance under a long (or long-queued) night. When it advances
with a **conflicting** change the PR goes `mergeable_state: dirty`, and GitHub
cannot build the pull-request merge ref - so the `pull_request`-triggered
required checks **never register or complete**. Without conflict awareness the
loop would wait out the whole `ci_timeout_minutes`, re-run the agent, and re-wait
on an unchanged head, burning `ci_max_tries x ci_timeout` on checks that can
never go green.

So before each CI wait the loop reads the PR's mergeability
(`getPullRequestMergeState`, polling while GitHub computes it) and maps it with
the pure `packages/core/src/conflict-gate.ts::classifyMergeability`:

- **clean / behind / blocked / unstable ->** proceed to the CI wait as usual
  (a non-conflict "out of date" state is GitHub's own required check to handle).
- **`mergeable: null` (still computing) ->** poll briefly, then fall open to the
  CI wait so an unknowable state never blocks the night.
- **`dirty` ->** fetch the current base and **rebase the branch onto it**
  (`git-ops.ts::rebaseOnto`, fetch-first). A clean rebase is force-pushed with
  `--force-with-lease` (which refuses to clobber a concurrent push - the
  ownership guard for a rewritten history); a conflicting rebase re-runs the
  agent to resolve the markers (up to `conflict_max_tries` passes), stages and
  continues the rebase, then force-pushes and resumes the CI gate on the rebased
  head. All git runs host-side; the agent container still holds no token and
  never sees `.git`, and the branch is still exactly one PR (the idempotency
  marker).

When the bounded rebase-and-re-run cannot resolve the conflicts, fixowl aborts
the rebase and leaves the draft flagged **`needs-rebase`** - a distinct PR-body
section, issue comment, and run-summary section ("Needs rebase") - and **stops
early** rather than entering a CI wait it can never satisfy. A `needs-rebase`
draft is not a hard failure (a PR was opened and the conflict surfaced), so it
never counts toward the all-failed wipeout. To shrink the born-dirty window the
night also re-fetches the default branch once at processing start (best-effort),
so branches are cut from the current tip rather than the one fetched at job start.

## Configuration

Set in `~/.fixowl/config.yaml` (the `fixowl init` config), in `defaults:` with
an optional per-repo override in `repos[]`, and propagated into the generated
workflow at `fixowl provision` time (`action.yml` inputs `max-ci-tries` /
`ci-timeout-minutes` / `conflict-max-tries`; the conflict input is rendered only
on a non-default value).

| key | default | meaning |
| --- | --- | --- |
| `ci_max_tries` | `3` | Max agent passes before a draft PR is left. |
| `ci_timeout_minutes` | `60` | How long each pass waits for the required checks. |
| `conflict_max_tries` | `2` | Max agent passes to resolve a dirty PR's conflicts before leaving a `needs-rebase` draft. |

## Security

All GitHub API calls and every git push stay host-side; the coding agent stays
credential-less, the `.git` dir never enters a container, and containers keep
`--cap-drop ALL` and non-root. The loop only *reads* CI state, so the App
carries read-only Checks / Commit statuses / Actions / Administration on top of
its Contents/Pull requests/Issues write - no new write, and fixowl still has no
merge capability (`no-merge.test.ts`).

**The gate is real because the runtime credential is a GitHub App.** Reading
GitHub Actions **check runs** needs a "Checks" permission GitHub grants to Apps
but does not expose to fine-grained PATs, which is why a PAT is not accepted as
the runtime credential. An App installation with `Checks: read` reads check runs,
so a green head flips the draft PR to ready and a red one keeps it a draft. The
installation token expires in ~1h but auto-refreshes across the whole night
(`@octokit/auth-app`), so a long fix loop never breaks on a stale credential.
See [app-auth.md](app-auth.md).

Should an App nevertheless lack `Checks: read` (`fixowl init` and
`fixowl validate` refuse one), the check-runs read 403s and the gate
**degrades** (warns and flips to ready after a settle window) rather than
failing. That degrade is reported as a distinct **`unverified`** outcome, never
"green": because no check was ever consulted, the PR body and issue comment say
CI could not be verified and to review CI before merging - they never claim the
checks passed.

CI logs and check summaries are semi-untrusted and enter retry prompts only
inside `<untrusted-ci-output>` fences, length-capped, exactly like issue bodies.
See [security.md](security.md).
