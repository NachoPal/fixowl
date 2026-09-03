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
- **Dependency-aware**: the agent first classifies the night's issues; ones
  that touch the same code are fixed as a chain of stacked PRs (each targeting
  its parent branch), independent ones in parallel off the default branch. See
  [docs/stacked-prs.md](docs/stacked-prs.md).
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
fixowl init          # scaffolds ~/.fixowl/{config.yaml,secrets.env}, prints PAT instructions
fixowl validate      # tokens, repos, docker engine, agent credentials
fixowl provision     # labels + sealed secrets + workflow into each repo (also proposes
                     # a starter .fixowl.yml and issue template via PR)
fixowl start         # installs, registers, and starts the runner service(s)
```

Then file an issue, label it `overnight`, and check back tomorrow. Or trigger a
night right now:

```sh
fixowl run owner/repo
```

Other ops: `fixowl status`, `fixowl stop [--deregister]`, `fixowl logs owner/repo [--runner]`.

## Configuration

`~/.fixowl/config.yaml` (secrets stay in `~/.fixowl/secrets.env`, chmod 600,
referenced as `${VAR}`):

```yaml
version: 1
github:
  admin_token: ${FIXOWL_ADMIN_TOKEN}      # provisioning; stays on your machine
  runtime_token: ${FIXOWL_RUNTIME_TOKEN}  # pushed to repos as an Actions secret
defaults:
  schedule: "37 1 * * *"                  # UTC
  labels: { any: [overnight] }            # any/all combinations supported
  agent: claude
  max_issues_per_run: 4
  issue_timeout_minutes: 45
agents:
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] }   # the ONLY env vars agents ever see
repos:
  - name: you/your-app
    schedule: "30 1 * * *"                # per-repo override
```

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

## License

MIT
