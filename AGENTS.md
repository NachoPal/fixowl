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

## Hard invariants

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
- **One PR per issue**, branch `issue/<n>-<slug>`. The branch is the idempotency marker.

## Conventions

- Actions in workflows are SHA-pinned with a `# vN` comment. Workflows get minimal
  `permissions:`. actionlint runs in CI over both our workflows and rendered templates.
- Spawn processes with argv arrays, never shell string interpolation.
- Keep modules pure where possible; push I/O to the edges behind `deps.ts` interfaces.
