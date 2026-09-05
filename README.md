![fixowl - the owl that fixes your issues while you sleep. You file and label issues during the day; a nightly cron picks them up on a self-hosted runner, runs a coding agent in a Docker container per issue, verifies the change, and opens exactly one pull request per issue with the evidence attached. fixowl never merges.](assets/readme-banner.png)

# fixowl

**The owl that fixes your issues while you sleep.**

During the day you file GitHub issues and label them `overnight`. Every night,
on a cron schedule, fixowl picks them up on a self-hosted runner, runs a coding
agent (Claude Code by default, swappable) inside a Docker container per issue,
verifies the change when possible (headless Playwright screenshots for web
apps, test suites otherwise), and opens **exactly one pull request per issue**
with the evidence attached.

In the morning you review. **fixowl never merges.**

## How it works

![Setup, once: fixowl provision pushes labels, sealed secrets and the workflow file to your repo on GitHub, and fixowl start installs and runs the self-hosted runner service on the runner host. Every night: the workflow's cron dispatches a job to that runner while your laptop is asleep, and the fixowl action selects issues labeled overnight, classifies them into dependency chains, runs the agent in a Docker container per issue with no GitHub token inside, and verifies the result before pushing the branch and opening exactly one pull request per issue with evidence attached. In the morning: you review the pull request, and fixowl never merges.](assets/how-it-works.svg)

- **One PR per issue**, branch `issue/<n>-<slug>`. The branch doubles as the
  idempotency marker: reruns never duplicate work, and deleting the branch is
  how you ask for a retry.
- **Dependency-aware**: two layers decide branch topology. First, fixowl reads
  the night's issues' native GitHub `blocked-by` edges and enforces them: a
  dependent stacks on and ships after its prerequisite when that prerequisite is
  also shipping tonight, and is otherwise **deferred** (the prerequisite isn't
  selected, failed to ship, is cross-repo, or forms a cycle - deferrals are
  logged and listed in the night summary). Then a heuristic pass classifies the
  remaining issues by whether they touch the same code and stacks those too;
  prerequisites always win over that heuristic. Issues are fixed one at a time -
  topology, not concurrency. See [docs/stacked-prs.md](docs/stacked-prs.md).
- **Verification is a capability, not a mandate**: repos declare checks and
  optional web screenshot targets in `.fixowl.yml`; missing capability
  degrades to "unavailable", failing checks turn the PR into a draft, and
  screenshots/logs land in the run's `fixowl-evidence` artifact.
- **Agent-agnostic**: adapters for `claude` (default), `aider`, and a
  deterministic `script` adapter used for e2e tests (test-only: it executes
  issue bodies as shell, so the action refuses it without an explicit
  `FIXOWL_UNSAFE_SCRIPT_AGENT=1` opt-in). Adding one is a few lines in
  `packages/core/src/agent-adapters.ts`.
- **Cloud-portable by construction**: the generated workflow has no
  `container:` key and no host assumptions; swapping `runs-on` to
  `ubuntu-latest` is the entire migration.
- **Sandboxed and never-merging**: the agent container gets no GitHub token,
  no docker socket, dropped capabilities, and resource limits; pushes happen
  on the host by the harness. See [docs/security.md](docs/security.md).

## Quick start

```sh
npm install -g fixowl
fixowl init          # guided setup, start to finish
```

`init` walks through the whole thing and writes nothing until you have answered:

1. the two fine-grained PATs (it verifies each one against GitHub as you paste it),
2. the coding agent and its credential,
3. one or more repos: schedule (local `HH:MM`, converted to a UTC cron), labels,
   and how many issues a night may take on,

then runs the rest for you and stops with an explanation if a step fails:

```sh
fixowl validate      # tokens, repos, docker engine, agent credentials
fixowl provision     # labels + sealed secrets into each repo, registers the runner
                     # on this host, and proposes the workflow, a starter .fixowl.yml,
                     # and an issue template via PR (--no-pr pushes the workflow direct)
fixowl start         # installs and starts the runner service(s); no admin token needed
```

The admin token is **setup-only**: `fixowl provision` is the only thing that
spends it (registration is the one step needing Administration: write). After
provisioning you can revoke it, or downgrade it to read-only if you want
`fixowl status`/`fixowl start` to confirm the runner is online. Routine
`fixowl start` needs no admin token. Provisioning from a different host than the
runner? Use `fixowl provision --no-register`, then `fixowl start --register` on
the runner host.

Those stay available on their own for later changes, and `fixowl init
--non-interactive` just scaffolds `~/.fixowl/{config.yaml,secrets.env}` for you
to fill in by hand.

Then file an issue, label it `overnight`, and check back tomorrow. Or trigger a
night right now:

```sh
fixowl run owner/repo
```

Other ops: `fixowl status`, `fixowl watch [owner/repo]` (stream a live agent
container's logs), `fixowl stop [--deregister]`, `fixowl logs owner/repo [--runner]`.

## Configuration

`~/.fixowl/config.yaml` (secrets stay in `~/.fixowl/secrets.env`, chmod 600,
referenced as `${VAR}`):

```yaml
version: 1
github:
  admin_token: ${FIXOWL_ADMIN_TOKEN}      # setup-only; stays on your machine, revocable after provision
  runtime_token: ${FIXOWL_RUNTIME_TOKEN}  # pushed to repos as an Actions secret
defaults:
  schedule: "37 1 * * *"                  # UTC
  labels: { any: [overnight] }            # any/all combinations supported
  agent: claude
  max_issues_per_run: 4
  issue_timeout_minutes: 45
  model: sonnet                           # default model when no selector label
  effort: medium                          # default reasoning effort
agents:
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] }   # the ONLY env vars agents ever see
repos:
  - name: you/your-app
    schedule: "30 1 * * *"                # per-repo override
    model: opus                           # per-repo default override
    label_models:                         # dedicated selector labels (see below)
      heavy: { model: opus, effort: max }
      quick: { model: haiku, effort: low }
```

### Model and reasoning effort

You control which model and reasoning effort the coding agent runs with, two
ways that compose:

- **Per-label (`label_models`).** Dedicated selector labels - separate from the
  `overnight`-style pickup labels - each mapping to a `{ model, effort }`. An
  issue carrying **exactly one** selector label runs with that model/effort. An
  issue carrying **two or more** is refused loudly (that one issue fails with a
  clear error; the rest of the night is untouched). `fixowl provision` creates
  the selector labels on the repo alongside the pickup labels.
- **Default (`model` / `effort`).** In `defaults`, overridable per repo, used
  when an issue carries no selector label. Set neither and fixowl passes no
  `--model`/effort flag, falling through to the agent CLI's own default.

Every model and effort is validated against the agent that repo uses (the
catalog lives in `packages/core/src/agent-catalog.ts`). `fixowl init` offers
them as arrow-key lists - selector labels are ticked off the repo's own labels,
then each gets a model and an effort - and `fixowl validate` rejects any
unknown value. For
`claude`, models are aliases like `opus`/`sonnet`/`haiku`/`fable` and efforts
are `low`/`medium`/`high`/`xhigh`/`max` (both passed as `--model`/`--effort`).

Each target repo carries a `.fixowl.yml` (proposed by `provision` when
missing) declaring its Dockerfile, verify commands, optional web screenshot
targets, and repo-specific prompt instructions. The Dockerfile contract: the
image contains the agent CLI, git, your toolchain, and (for web verification)
Playwright with chromium. Samples live in [templates/dockerfiles/](templates/dockerfiles/).

## Runner host

Any Mac or Linux box with Docker. The reference setup is a spare Intel MacBook
Pro with Colima; the host runs nothing stack-specific, only Docker and the
runner. See [docs/host-bootstrap.md](docs/host-bootstrap.md).

## Development

```sh
pnpm install
pnpm lint        # oxlint + oxfmt + tsc
pnpm test        # vitest, including an in-process e2e of a whole night
pnpm build       # bundles the action (dist/, checked in) and the CLI
```

The monorepo: `packages/core` (pure logic), `packages/action` (the GitHub
Action), `packages/cli` (the `fixowl` command). All side effects run behind
interfaces, so the entire night loop is tested in-process with a real git
sandbox and fake GitHub/Docker.

Releases are cut by a manual workflow from the version committed in the code
(`packages/cli/package.json`, the single source of truth). See
[docs/releasing.md](docs/releasing.md).

## License

MIT
