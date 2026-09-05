---
status: accepted
date: 2026-09-05
decision-makers: [captain (NachoPal)]
---

# 0001. Validate fixowl end-to-end with a release-gated, real-call test on GitHub-hosted runners

## Context and Problem Statement

fixowl has no end-to-end test today: `release.yml` runs `pnpm lint`, `pnpm test`, and `pnpm build` over pure logic (vitest against in-process fakes), so nothing ever exercises the real path - a real coding-agent API call, a `docker run` on a real host, a real `git push`, a real PR opened on GitHub, and real CI polled to green. That last mile is the part most likely to break silently between releases (auth, the agent adapter, the container run, the PR/CI flow). We want to validate it, but a real run costs money and cannot run cheaply on every CI or locally, so the test must be deliberately gated and isolated.

## Considered Options

* **A - No E2E (status quo):** rely on pure/unit tests only.
* **B - Local or self-hosted E2E:** run the full flow on the self-hosted runner or a developer machine.
* **C - Release-gated real-call E2E on GitHub-hosted runners, against a dedicated sandbox repo, plus a free `script`-adapter plumbing E2E** (chosen).

## Decision Outcome

Chosen option: **C**. Add one `e2e` job to `release.yml`, gated to run only on a release dispatch, on `ubuntu-latest`, that:

- creates 2-3 throwaway `for: agent` issues plus one native `blocked_by` edge in a dedicated persistent sandbox repo (`NachoPal/fixowl-e2e-sandbox`), using a sandbox-scoped `FIXOWL_E2E_SANDBOX_TOKEN` secret;
- runs the freshly-built `dist/action/index.js` retargeted at that sandbox - invoked as `node dist/action/index.js` with `GITHUB_REPOSITORY` / `GITHUB_WORKSPACE` / `RUNNER_TEMP` set via shell `export` (a declarative `env:` override of the `GITHUB_*`/`RUNNER_*` vars is ignored by the runner) - with `default-model: sonnet` / `default-effort: medium` / `label-models: ""` so every issue is cheap regardless of its effort label;
- authenticates with the existing Claude subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) already in fixowl's secrets;
- asserts loosely that PRs landed on the expected `issue/<n>-*` branches with the `blocked_by` order respected and CI green (tolerating agent nondeterminism); and
- tears everything down (issues, PRs, branches) under `if: always()`.

In addition, add a free, deterministic `script`-adapter E2E that exercises the whole pipeline plumbing (selection -> dependency ordering -> docker build -> container run -> local pre-check -> push -> CI-gate -> PR -> verify) with zero LLM spend, on a main-push / nightly cadence.

### Decisions ratified

The captain ratified the following three points on 2026-09-05:

1. **Gating - report-only to start.** The real-call sonnet E2E begins **report-only**
   (`continue-on-error` with a loud step summary), **not** a hard release gate. A paid,
   nondeterministic agent test must not be able to veto a release on its first flake. It may be
   promoted to a hard gate later, once its flake rate is known over several releases.

2. **Sandbox isolation - Option A (persistent dedicated repo).** Use a persistent, dedicated
   `NachoPal/fixowl-e2e-sandbox` repo, provisioned once, with per-run fixtures torn down under
   `if: always()`, and a sandbox-scoped `FIXOWL_E2E_SANDBOX_TOKEN` secret added to fixowl's Actions
   secrets. This fully isolates the blast radius, keeps the token minimal (no repo-admin), and keeps
   the docker image build fast. Rejected alternatives: a throwaway repo created and deleted per run
   (needs a much riskier repo-admin token and a destructive `gh repo delete`), and reset-in-place on
   the real fixowl repo behind a label filter (one config slip = fake PRs on the real repo).

3. **Tiers and cadence - two-tier plan.** Adopt both tiers: a **free `script`-adapter E2E**
   (deterministic, zero LLM spend, exercising the whole pipeline plumbing) plus the **paid real-call
   `claude` sonnet release E2E**. Run the free tier on **main-push + nightly** (not every PR, which
   would race concurrent runs on the one shared sandbox); keep the paid tier gated to release.

### Consequences

* Good, because it validates the one thing pure tests never touch: a real agent, real auth, real `--model` / `--effort` flags, a real container run, and a real PR reaching green CI.
* Good, because the dedicated sandbox repo isolates all fake issues, PRs, and branches, so the real fixowl repo is never polluted and a fake PR can never be accidentally merged.
* Good, because the free `script`-adapter tier catches pipeline-plumbing regressions cheaply on every main-push, leaving only the real-agent confirmation to the paid, release-gated run.
* Good, because cost is trivial (~$0.30-0.75, or a small slice of the subscription usage window, per release run).
* Bad, because it adds infrastructure the project did not have: a dedicated sandbox repo and a sandbox-scoped secret, both requiring org-admin setup.
* Bad, because a real agent is nondeterministic, forcing loose assertions and an initially report-only gate rather than an exact-diff, hard-blocking test.
* Bad (constraint accepted), because the action must be invoked as the built binary with shell-`export`ed `GITHUB_*` vars.
* Coverage boundary: this validates the action -> docker -> agent -> push -> PR -> CI-gate flow on GitHub-hosted runners, but does **not** cover self-hosted runner registration, the launchd fallback trigger, or the scheduled-slot budget guard (inert on manual/release dispatch). The job summary should say so, so a green run is not over-read.

## More Information

- Related work in this repo: the CI-gated fix loop (`docs/ci-fix-loop.md`) and the codex coding-agent adapter, both of which this test would exercise end to end.
- `blocked_by` write API used for fixtures: `POST /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` with body `{"issue_id": <blocker database id>}`, and a matching `DELETE` for cleanup.
- This is the first ADR in this repository; future architecturally significant decisions should be recorded the same way under `docs/adr/`.
