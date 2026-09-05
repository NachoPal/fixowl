# fixowl - agent instructions

fixowl is an overnight GitHub issue-fixing agent: a TypeScript CLI + GitHub Action pair.
During the day you file labeled issues; on a cron schedule a self-hosted runner picks them
up, runs a coding agent in a Docker container per issue, verifies the change when possible,
and opens exactly one PR per issue. It never merges.

## Layout

- `packages/core` - shared pure logic: config schemas (zod), workflow template, branch
  naming, agent adapters, label rules. No I/O.
- `packages/action` - the GitHub Action (`action.yml` at repo root points at the checked-in
  bundle `dist/action/index.js`). All side effects go through the interfaces in
  `src/deps.ts` so the whole night can run in-process against fakes.
- `packages/cli` - the `fixowl` npm CLI: provisioning, runner lifecycle, ops commands.
- `templates/` - starter files pushed into target repos.
- `docs/` - operator docs (host bootstrap, stacked PRs, security model).

## Commands

- `pnpm lint` - oxlint + oxfmt + tsc. The single lint entry CI invokes.
- `pnpm test` - vitest. The single test entry CI invokes.
- `pnpm build` - esbuild bundles for the action (`dist/action/index.js`, checked in;
  CI fails if stale) and the CLI (`packages/cli/dist`, gitignored).

Releases are cut manually by `.github/workflows/release.yml` from the BASE version
committed in `packages/cli/package.json` (the single source of truth); the channel
(`release`/`prerelease`/`draft`) and any prerelease suffix (`version_suffix`, e.g.
`-rc.1`) are chosen at trigger time and resolved into a plan by the pure,
unit-tested `scripts/release-channel.ts`. Any suffix is applied only ephemerally
in-CI for the publish; the workflow never bumps, commits, or pushes a version.
See [docs/releasing.md](docs/releasing.md).

## Hard invariants

- **The admin token is setup-only.** Runner registration (the only step needing
  Administration: write) lives in `fixowl provision` (and the explicit
  `fixowl start --register` for another host), via `registerRunner`
  (`packages/cli/src/runner/register.ts`). Routine `fixowl start` uses no admin
  token; its online check (and `fixowl status`) soft-fails when the token is
  revoked/downgraded. Never move a write-scoped GitHub call into the routine
  `start` path, and never grant the runtime token any Administration **write**
  (or other write beyond Contents/Pull requests/Issues). The CI-gated fix loop
  adds read-only Checks/Statuses/Actions/Administration to the runtime token so
  it can read required checks and CI logs; that read-only Administration is the
  only Administration the runtime token ever holds. See
  [docs/security.md](docs/security.md) and [docs/ci-fix-loop.md](docs/ci-fix-loop.md).

- **Never merge.** No code path may call a GitHub merge API. `no-merge.test.ts` greps for
  it; do not weaken that test.
- **The coding agent never holds a GitHub token.** Only the allowlisted env vars in the
  agent adapter enter the per-issue container. Commits and pushes happen on the host
  (the runner), outside any container.
- **The git dir never enters a container.** `.git` is moved out of the workspace for the
  night (`extractGitDir`), containers mount a git-less working tree, and host git always
  runs with an explicit `--git-dir`, so a `.git` planted in the workspace is inert.
- **Issue bodies are untrusted input.** They enter prompts only inside
  `<untrusted-issue-body>` fences, and container hardening assumes fencing fails.
  CI logs and check summaries are semi-untrusted the same way (a job can echo
  attacker-controlled text): the CI-gated loop feeds them back only inside
  `<untrusted-ci-output>` fences, length-capped, via `fenceUntrustedCiOutput`.
- **Exactly one level of containerization.** The runner is native; the action calls
  `docker run` once per agent/verify step. Nothing invokes Docker from inside a container.
- **Containers run non-root.** Every `docker run` (agent, classifier, verify) runs as
  the host runner's uid/gid with an explicit writable `HOME` - injected once in
  `DockerEngine.run` (`container-exec.ts`), not per target Dockerfile. The Claude CLI
  hard-refuses `--dangerously-skip-permissions` under uid 0, and matching the host uid
  keeps bind-mount writes to `/workspace` owned correctly on Linux. Do not drop `--user`.
- **One PR per issue**, branch `issue/<n>-<slug>`. The branch is the idempotency marker.

## Conventions

- The container name format (`fixowl-<repo>-<issue|classify>-<purpose>`) is owned by
  `packages/core/src/container-naming.ts` (`containerName`, `containerNamePrefix`,
  `parseContainerName`). The action re-exports `containerName` from `container-exec.ts`;
  the CLI's `watch` command discovers live containers via the same helpers. Do not
  re-derive the slug shape anywhere else.
- Actions in workflows are SHA-pinned with a `# vN` comment. Workflows get minimal
  `permissions:`. actionlint runs in CI over both our workflows and rendered templates.
- Spawn processes with argv arrays, never shell string interpolation.
- Keep modules pure where possible; push I/O to the edges behind `deps.ts` interfaces.
- The valid model ids and effort levels per agent live in one place,
  `packages/core/src/agent-catalog.ts`; init, validation, and the adapters all
  read it. Extend an agent there rather than hardcoding a model list elsewhere.
  Per-issue model/effort resolution is pure logic in
  `packages/core/src/model-selection.ts`.
- The optional local fallback trigger backs up GitHub's flaky `schedule` cron:
  a per-repo macOS launchd agent runs `fixowl fallback check` after the cron and
  dispatches the workflow only if today's `schedule` run is missing. Pure
  decisions (`decideFallbackDispatch`, plus the once-a-day slot budget guard
  `guardScheduledSlot` the action runs at night start) live in
  `packages/core/src/fallback-dispatch.ts`; launchd/plist + DST-safe timing in
  `packages/cli/src/runner/fallback-launchd.ts`; commands in
  `packages/cli/src/commands/fallback.ts`. It uses its own least-privilege
  `FIXOWL_FALLBACK_TOKEN` (Actions: write only) so the admin token stays
  setup-only and revocable. See [docs/local-fallback.md](docs/local-fallback.md).
- Night planning is two layers of pure logic between selection and the stacking
  loop in `main.ts`. Layer 1 (`packages/action/src/prereq-planner.ts`) enforces
  native `blocked-by` edges - fetched read-only via `GitHubApi.getIssueDependencies`
  (`entry.ts`, one aliased GraphQL query) - deferring a dependent whose
  prerequisite is not shipping tonight. Exception (issue #48): a native
  prerequisite that idempotency skipped because its branch is in flight becomes a
  `stackBase` instead of a defer, gated on PR liveness (open+unmerged) via the
  read-only `GitHubApi.getPullRequestForBranch`; the dependent's PR then stacks on
  that already-pushed branch. Liveness, not branch existence: a merged PR is
  satisfied (base from default), a closed-unmerged/PR-less branch defers. This is
  native-edge-only. Layer 2 (`classify.ts`, the same-code heuristic) is
  **opt-in and off by default** (issue #49): the `heuristic_conflict_ordering`
  config flag (`config-schema.ts` -> `action.yml` input -> `main.ts`) gates it.
  When off, `main.ts` skips the classifier LLM call entirely and passes
  `allIndependent` to `merge-graph.ts`; when on, it classifies as before. Either
  way `merge-graph.ts` overlays the groups on the Layer-1 order under
  "prerequisites always win", never stacks on a skipped branch across nights, and
  Layer 1 is unaffected. Default-off rationale (fixowl never merges, so it never
  restacks; independent PRs review more robustly; the classifier is a paid LLM
  guess) lives in `docs/stacked-prs.md`. Empty edges + Layer 2 off == the
  pre-dep-graph behavior (the regression guard in `main.test.ts`).
- The per-issue runner (`packages/action/src/issue-pipeline.ts::processIssue`)
  is a bounded CI-gated fix loop, not one-shot: agent -> local pre-check
  (`.fixowl.yml`, a cheap smoke test) -> push -> wait for the base branch's
  *required* checks -> green flips the draft PR to ready, red/timeout feeds the
  failures back and retries, up to `ci_max_tries`, then leaves an annotated
  draft. The pure gate decision is `packages/core/src/ci-gate.ts`; the poll loop
  is `ci-poll.ts` (inject a `Clock` in tests); `getRequiredChecks`/`getChecksForRef`/
  `getFailedCheckLogs` live behind `deps.ts`. Config is `ci_max_tries` (3) /
  `ci_timeout_minutes` (60) in `config-schema.ts`, propagated through
  `provision` -> `action.yml` inputs. See [docs/ci-fix-loop.md](docs/ci-fix-loop.md).

- Run budgets (issue #21) bound the night with a set of independent,
  each-optional stop conditions - count (`max_issues_per_run`), usage %
  (`usage_budget_percent`), graceful wall-clock (`run_budget_minutes`) - and the
  run stops on the first that trips. The trip/no-trip and first-trip-wins logic
  is pure in `packages/core/src/run-budget.ts`; `main.ts` assembles the state
  snapshot and evaluates it at two gates (pre-run, and between-issues at the top
  of the inner loop). Keep the conditions pure and keep state assembly the only
  I/O, so parallel chains (#36) only have to make the snapshot consistent. Usage
  is read out-of-band on the host behind the model-agnostic `UsageReader`
  (`agent-usage.ts`, selected by `getUsageReader(agentName)`); an agent with no
  observable window returns `undefined` and opts out automatically, and a read
  failure is advisory (abstains, never aborts the night). `usage_budget_percent`
  and `run_budget_minutes` have no built-in resolution fallback (unset == opted
  out), so a pre-#21 config is unchanged; the starter values in `FIXOWL_DEFAULTS`
  are only what `fixowl init` writes. `max_issues_per_run` stays the count cap and
  still bounds how many issues are selected/classified. See the README "Run
  budgets" section.

- Per-issue evidence is uploaded **progressively**, not only at job end. As each
  issue finishes, `main.ts` uploads its `fixowl-evidence/issue-<n>/` dir as its
  own `fixowl-evidence-issue-<n>` artifact via the `ArtifactUploader` deps edge
  (`artifact-upload.ts`, `@actions/artifact`), so completed issues' evidence is
  finalized mid-job and survives a later job cancellation - the single end-of-job
  `upload-artifact` step never runs on a cancelled job (the runner reconnects
  after the job is server-side "completed" and that upload 403s). Per-issue names
  are mandatory: `@actions/artifact` v2+ forbids two artifacts sharing a name in
  one run. Naming/paths are pure in `evidence.ts` (shared with `pr-body.ts`,
  which links each PR to its own issue artifact); the workflow keeps the combined
  end-of-job `fixowl-evidence` upload as the fully-successful fallback. Upload is
  best-effort (a failure is logged, never aborts the night); in-process tests
  inject a fake or omit it. The one accepted limit: the issue in progress at the
  freeze may lose its evidence (its container was frozen).

- Real-call end-to-end tests run the *whole* action against a dedicated,
  persistent sandbox repo (`NachoPal/fixowl-e2e-sandbox`), not fakes. Two tiers:
  the paid `e2e` job in `.github/workflows/release.yml` (release dispatch only,
  `continue-on-error` report-only, real `claude` sonnet call) and the free
  `.github/workflows/e2e-script.yml` (main-push + nightly, `script` adapter, zero
  LLM spend). Both share fixtures in `scripts/e2e/{seed,assert,cleanup}.sh` and
  the one `fixowl-e2e-sandbox` concurrency group so the shared sandbox is never
  raced. Load-bearing trick: the action reads `GITHUB_REPOSITORY`/`GITHUB_WORKSPACE`
  from `process.env` and the runner *ignores* `env:` overrides of `GITHUB_*`, so
  the job runs `node dist/action/index.js` with those set via shell `export` -
  never `uses: ./` (which would hit the real repo). Loose assertions only (agent
  is nondeterministic): PRs on `issue/<n>-*`, blocked_by stacking, `isDraft==false`
  == CI green. Design in [docs/adr/0001-release-gated-real-call-e2e-test.md].
  Coverage gap (stated in each job summary): NOT self-hosted runner registration,
  the launchd fallback, or the scheduled-slot budget guard. This is distinct from
  `scripts/local-docker-e2e.ts` (`pnpm e2e:docker`), an in-process real-docker /
  fake-GitHub run with no network writes.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this
project. Do not repeat what the codebase already shows; point to the
authoritative file or command instead. Prefer rewriting or pruning existing
entries over appending new ones, and keep entries concise.
