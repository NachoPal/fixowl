# Contributing to fixowl

Thanks for helping fixowl fix more issues while people sleep. This guide covers
local setup, the conventions CI enforces, and the **hard invariants** that keep
the overnight run safe. Please skim the invariants before your first PR - they
are enforced by tests, so a change that breaks one fails CI.

**Most-wanted contribution:** teaching fixowl to drive a new coding agent or
model. The runner is agent-agnostic by design, and adding an adapter is a small,
well-isolated change. It has its own first-class guide:
**[docs/adding-an-agent-adapter.md](docs/adding-an-agent-adapter.md).**

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Add a coding-agent / model adapter** - the highlighted path; see the guide
  above. Open a [new-adapter request](https://github.com/NachoPal/fixowl/issues/new/choose)
  first if you want to discuss the target agent.
- **Fix a bug or build a feature** - issues labelled
  [`good first issue`](https://github.com/NachoPal/fixowl/labels/good%20first%20issue)
  and [`help wanted`](https://github.com/NachoPal/fixowl/labels/help%20wanted)
  are the best starting points.
- **Improve the docs** - the operator docs in [docs/](docs/) and the READMEs.

For anything larger than a small fix, please open an issue first so we can agree
on the approach before you invest time.

## Project layout

fixowl is a pnpm monorepo of three packages (details in [AGENTS.md](AGENTS.md)):

- `packages/core` - shared **pure** logic: config schemas (zod), the workflow
  template, branch naming, **the agent adapters and model catalog**, label
  rules. No I/O.
- `packages/action` - the GitHub Action that runs the night. All side effects
  go through the interfaces in `src/deps.ts`, so the whole night can run
  in-process against fakes.
- `packages/cli` - the `fixowl` npm CLI: provisioning, runner lifecycle, ops.

Keep modules pure where you can and push I/O to the edges behind `deps.ts`.

## Local setup

You need Node 24 and [pnpm](https://pnpm.io/) (the repo pins a version via
`packageManager`; `corepack enable` will pick it up).

```sh
pnpm install          # install workspace dependencies
pnpm lint             # oxlint + oxfmt + tsc - the single lint entry CI runs
pnpm test             # vitest, including an in-process e2e of a whole night
pnpm build            # bundles the action (dist/, checked in) and the CLI
```

`pnpm install` also wires up a Husky **pre-commit hook** (via the `prepare`
script - no manual `git config` needed). When a commit stages changes under
`packages/core` or `packages/action` it runs `pnpm build` and re-stages the
regenerated `dist/action/index.js`, so you never commit a stale bundle;
commits that touch only docs, the CLI, or tests take a fast path and skip the
build. It is a convenience only: it is bypassable with `git commit --no-verify`,
and the CI [Bundle freshness](#bundle-freshness) check remains the authoritative
gate.

`pnpm lint` and `pnpm test` are the two commands CI gates on; run both before
opening a PR. `pnpm build` matters because the action bundle is committed - see
[Bundle freshness](#bundle-freshness) below.

## Branch & PR conventions

- Branch off `main`; name branches descriptively (e.g.
  `feat/codex-adapter`, `fix/ci-poll-timeout`, `docs/adapter-guide`).
- **fixowl is squash-merge only.** Keep your PR a single clean branch; do not
  stack it on another open PR.
- Write a clear, human-readable PR description of *what* changed and *why*, and
  fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) checklist.
- Reference the issue you are resolving with `Closes #<n>` in the description.
- Keep PRs focused. A behaviour change plus a large unrelated refactor is two
  PRs.

## CI gates

Every PR runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml). It must be
green to merge. The steps, and how to reproduce each locally:

| CI step | Reproduce locally | What it checks |
| --- | --- | --- |
| **actionlint** | `actionlint` | Lints the repo's workflows *and* the rendered templates. |
| **Lint** | `pnpm lint` | oxlint + oxfmt (formatting) + `tsc` (types). |
| **Test** | `pnpm test` | The full vitest suite. |
| **Bundle freshness** | `pnpm build && git diff --exit-code -- dist` | The checked-in action bundle is up to date. |

### Bundle freshness

The GitHub Action is shipped as a **checked-in bundle** at `dist/action/index.js`
(the repo-root `action.yml` points at it). If you change anything the action
bundles - most of `packages/core` and `packages/action` - you must rebuild and
commit the result:

```sh
pnpm build
git add dist
```

CI runs `pnpm build` then `git diff --exit-code -- dist`, so a stale bundle
fails the run. If your PR only touches docs, `.github/`, or the CLI, the bundle
will not change and this step is a no-op.

The Husky pre-commit hook (see [Local setup](#local-setup)) rebuilds and
re-stages the bundle for you when you stage bundle inputs, so `git add dist`
above is usually automatic - but CI is still the real gate.

### SHA-pinned actions

Every third-party action used in a workflow is **pinned to a full commit SHA**
with a trailing `# vN` version comment, and workflows declare a minimal
`permissions:` block. For example:

```yaml
- uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
```

`actionlint` runs in CI over both our workflows and the rendered templates, so a
tag-pinned or unpinned action (or a workflow lint error) fails the build. When
you bump an action, update both the SHA and the `# vN` comment together.

## Hard invariants (do not break these)

These hold regardless of configuration, and most are enforced by tests that fail
CI if weakened. [AGENTS.md](AGENTS.md) is the authoritative list with file
pointers; [SECURITY.md](SECURITY.md) explains the trust model. The essentials a
contributor must never violate:

- **fixowl never merges.** No code path may call a GitHub merge API. A
  grep-based test (`packages/action/src/no-merge.test.ts`) keeps it that way -
  do not weaken it. Every fix lands as a PR for a human to review.
- **The coding agent never holds a GitHub token.** Only the env vars in an
  adapter's allowlist enter the per-issue container, and the allowlist
  *structurally* refuses GitHub-shaped credentials (`FORBIDDEN_AGENT_ENV` in
  `packages/core/src/agent-adapters.ts`). Never add a GitHub token to an
  adapter's `env`, and never route commits/pushes through the container - they
  happen on the host.
- **The `.git` directory never enters a container.** It is moved out of the
  working tree for the night, and host git always runs with an explicit
  `--git-dir`. Do not mount `.git` into a container or rely on it being present
  inside one.
- **Exactly one level of containerization.** The runner is native; the action
  calls `docker run` once per agent/verify step. Nothing invokes Docker from
  inside a container.
- **Containers run non-root.** Every `docker run` runs as the host runner's
  uid/gid with an explicit writable `HOME`, injected once in
  `DockerEngine.run`. Do not drop the `--user` flag.

If your change needs to bend one of these, it needs a design discussion first -
open an issue.

## Reporting bugs and security issues

- **Bugs / features / adapter requests:** open an issue via
  [the chooser](https://github.com/NachoPal/fixowl/issues/new/choose).
- **Security vulnerabilities:** do **not** open a public issue. Follow the
  process in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
