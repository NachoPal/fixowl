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
  `start` path, and never grant the runtime token Administration. See
  [docs/security.md](docs/security.md).

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
- Night planning is two layers of pure logic between selection and the stacking
  loop in `main.ts`. Layer 1 (`packages/action/src/prereq-planner.ts`) enforces
  native `blocked-by` edges - fetched read-only via `GitHubApi.getIssueDependencies`
  (`entry.ts`, one aliased GraphQL query) - deferring a dependent whose
  prerequisite is not shipping tonight. Layer 2 (`classify.ts`, unchanged same-code
  heuristic) runs over the non-deferred set; `merge-graph.ts` overlays its groups
  on the Layer-1 order under "prerequisites always win". Empty edges == the
  pre-dep-graph behavior (the regression guard in `main.test.ts`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this
project. Do not repeat what the codebase already shows; point to the
authoritative file or command instead. Prefer rewriting or pruning existing
entries over appending new ones, and keep entries concise.
