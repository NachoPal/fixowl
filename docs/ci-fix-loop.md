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
   failure or timeout ends the run on the existing agent-failed path.
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
   comment is posted. **Red or timeout ->** the failures are summarized back to
   the agent and the loop continues.

When the budget is exhausted, the draft PR is left with its body and an issue
comment listing each failing required check and a link to its run.

## Which checks gate

fixowl gates only on the checks GitHub marks **required** for the PR's base
branch (branch-protection or ruleset required status checks), read via the
branch-rules endpoint. When that is unreadable - no branch protection, or the
runtime token lacks the read scope - fixowl **falls back to gating on all
completed checks** and logs a warning; it never fails loud. Because an empty
fallback poll cannot by itself distinguish "CI has not registered its checks
yet" (common in the seconds right after a push) from "no CI configured", the
loop applies a short **settle window**: a zero-check fallback poll is not
accepted as green until that window elapses with still no checks. Once any check
appears the normal fallback decision applies at once. A repo with no branch
protection and no CI therefore still opens ready-for-review PRs after the settle
window (there is nothing to gate on).

## Configuration

Set in `~/.fixowl/config.yaml` (the `fixowl init` config), in `defaults:` with
an optional per-repo override in `repos[]`, and propagated into the generated
workflow at `fixowl provision` time (`action.yml` inputs `max-ci-tries` /
`ci-timeout-minutes`).

| key | default | meaning |
| --- | --- | --- |
| `ci_max_tries` | `3` | Max agent passes before a draft PR is left. |
| `ci_timeout_minutes` | `60` | How long each pass waits for the required checks. |

## Security

All GitHub API calls and every git push stay host-side; the coding agent stays
credential-less, the `.git` dir never enters a container, and containers keep
`--cap-drop ALL` and non-root. The loop only *reads* CI state, so the runtime
token gains read-only Checks / Commit statuses / Actions / Administration on top
of its Contents/Pull requests/Issues write - no new write, and fixowl still has
no merge capability (`no-merge.test.ts`). CI logs and check summaries are
semi-untrusted and enter retry prompts only inside `<untrusted-ci-output>`
fences, length-capped, exactly like issue bodies. See
[security.md](security.md).
