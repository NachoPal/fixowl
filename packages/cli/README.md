# fixowl

**The owl that fixes your GitHub issues while you sleep.**

During the day you file GitHub issues and label them `overnight`. Every night,
on a cron schedule, fixowl picks them up on a self-hosted runner, runs a coding
agent (Claude Code by default, swappable) inside a container per issue, verifies
the change when possible (headless Playwright screenshots for web apps, test
suites otherwise), and opens **exactly one pull request per issue** with the
evidence attached.

In the morning you review. **fixowl never merges.**

fixowl ships as two things from this one package: the `fixowl` CLI you run on a
runner host to provision repos and manage the runner, and the GitHub Action that
does the nightly work. This page covers both.

## Requirements

- **Node.js >= 24** (see `engines` in `package.json`).
- **A container engine - Colima or Docker.** fixowl runs the coding agent in a
  container per issue, so an engine must be present on the runner host:
  - `fixowl start` calls the engine and **auto-starts Colima** if it is installed
    but not running; it fails with a clear message if no engine is available.
  - `fixowl validate` checks for a working engine and reports the same failure
    when none is found.
  - The recommended install on macOS is Colima: `brew install colima docker`,
    then `colima start`. A plain Docker engine works too (fine for dev machines).

## Install

Install globally:

```sh
npm install -g fixowl
```

Or run it without installing:

```sh
npx fixowl init
```

## Quickstart

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
fixowl provision     # labels + sealed secrets into each repo, proposes the workflow
                     # via PR, and registers the runner on this host
fixowl start         # installs and starts the runner service(s); no admin token needed
```

Each of those stays available on its own for later changes. `fixowl init
--non-interactive` just scaffolds `~/.fixowl/{config.yaml,secrets.env}` for you
to fill in by hand.

Then file an issue, label it `overnight`, and check back tomorrow. Or trigger a
night right now:

```sh
fixowl run owner/repo
```

## CLI commands

Run `fixowl --help` for the full list; every command accepts
`-c, --config <path>` to point at a config file other than
`~/.fixowl/config.yaml`.

| Command                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixowl init`             | Guided setup: tokens, agent, repos, then validate, provision, and start. `--non-interactive` just scaffolds `~/.fixowl` and prints the manual steps.                                                                                                                                                                                                                                                                                                                                                                                              |
| `fixowl validate`         | Check tokens, repos, docker engine, and agent credentials. Exits non-zero if anything fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fixowl provision [repo]` | Create labels, seal secrets, propose the fixowl workflow via PR, and register the runner on this host (spends the admin token's Administration: write). The workflow is proposed on the `fixowl/provision-workflow` branch by default - merge that PR to activate scheduled runs; `--no-pr` pushes it straight to the default branch instead (`--pr` still names the default); `--no-schedule` generates a `workflow_dispatch`-only workflow (no cron); `--no-register` skips registration (register on the runner host with `start --register`). |
| `fixowl start [repo]`     | Install and start the self-hosted runner service(s); no admin token needed. Auto-starts Colima if installed. `--register` also registers the runner here first (needs admin Administration: write; for a host you didn't provision on).                                                                                                                                                                                                                                                                                                           |
| `fixowl stop [repo]`      | Stop the runner service(s). `--deregister` also uninstalls the service, deregisters it from GitHub, and deletes the install.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fixowl status [repo]`    | Show service, runner, last run, and open fixowl PRs per repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fixowl run <repo>`       | Dispatch the fixowl workflow now and follow it to completion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fixowl logs <repo>`      | Print the latest fixowl run's logs. `--runner` prints the local runner service diagnostics instead.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The optional `[repo]` argument narrows a command to a single repo; omit it to act
on every repo in your config.

## Using it as a GitHub Action

If you would rather run in the cloud than on your own runner, the same action is
consumable directly. The generated workflow has no `container:` key and no host
assumptions, so switching `runs-on` to `ubuntu-latest` is the entire migration.

```yaml
name: fixowl
on:
  schedule:
    - cron: "37 1 * * *" # UTC
  workflow_dispatch:

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  overnight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: NachoPal/fixowl@v0.2.0-rc.1
        with:
          labels-any: overnight
          agent: claude
          max-issues-per-run: "4"
          issue-timeout-minutes: "45"
        env:
          FIXOWL_GITHUB_TOKEN: ${{ secrets.FIXOWL_GITHUB_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Key action inputs (all optional; see [`action.yml`](https://github.com/NachoPal/fixowl/blob/main/action.yml) for the authoritative list):

| Input                   | Default     | Description                                                                                                                                                          |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labels-any`            | `overnight` | Comma-separated labels; an issue matches if it has ANY of them.                                                                                                      |
| `labels-all`            | `""`        | Comma-separated labels; an issue matches only if it has ALL of them.                                                                                                 |
| `agent`                 | `claude`    | Agent adapter to run (`claude`, `aider`).                                                                                                                            |
| `agent-env`             | `""`        | Comma-separated env var names allowed into the agent container, overriding the adapter's built-in allowlist.                                                         |
| `max-issues-per-run`    | `4`         | Maximum number of issues to process in one run.                                                                                                                      |
| `issue-timeout-minutes` | `45`        | Hard timeout for the agent container per issue.                                                                                                                      |
| `default-model`         | `""`        | Model id used when an issue carries no selector label. Empty uses the agent CLI's own default.                                                                       |
| `default-effort`        | `""`        | Reasoning effort for the default model. Empty passes no effort flag.                                                                                                 |
| `label-models`          | `""`        | JSON object mapping a selector label to `{"model","effort"}`. An issue with exactly one such label runs with that model/effort; two or more fails that issue loudly. |

> `fixowl provision` proposes this workflow to your repos for you (via a review
> PR by default; `--no-pr` pushes it straight to the default branch), pinned to a
> released tag - you don't have to author it by hand.

## Configuration & secrets

fixowl reads `~/.fixowl/config.yaml`; secrets live separately in
`~/.fixowl/secrets.env` (chmod 600) and are referenced from the config as
`${VAR}`. `fixowl init` writes both; `--non-interactive` scaffolds them for you
to fill in by hand.

```yaml
version: 1
github:
  admin_token: ${FIXOWL_ADMIN_TOKEN} # setup-only; stays on your machine, revocable after provision
  runtime_token: ${FIXOWL_RUNTIME_TOKEN} # pushed to repos as an Actions secret
defaults:
  schedule: "37 1 * * *" # UTC
  labels: { any: [overnight] } # any/all combinations supported
  agent: claude
  max_issues_per_run: 4
  issue_timeout_minutes: 45
  model: sonnet # default model when no selector label
  effort: medium # default reasoning effort
agents:
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] } # the ONLY env vars agents ever see
repos:
  - name: you/your-app
    schedule: "30 1 * * *" # per-repo override
    model: opus # per-repo default override
    label_models: # dedicated selector labels
      heavy: { model: opus, effort: max }
      quick: { model: haiku, effort: low }
```

fixowl uses **two fine-grained GitHub PATs**, both scoped to only the target
repos:

- an **admin** token used for provisioning, which stays on your machine
  (`~/.fixowl/secrets.env`);
- a **runtime** token that is sealed client-side and pushed to each repo as the
  Actions secret `FIXOWL_GITHUB_TOKEN`, used on the runner to author PRs.

The coding agent never holds a GitHub token: only the env vars in its adapter's
allowlist (for `claude`, `CLAUDE_CODE_OAUTH_TOKEN`) ever enter the per-issue
container. Each target repo also carries a `.fixowl.yml` (proposed by `provision`
when missing) declaring its Dockerfile, verify commands, optional web screenshot
targets, and repo-specific prompt instructions.

See [docs/security.md](https://github.com/NachoPal/fixowl/blob/main/docs/security.md)
for the full security model.

## Links

- **Repository:** https://github.com/NachoPal/fixowl
- **Issues:** https://github.com/NachoPal/fixowl/issues
- **License:** [MIT](https://github.com/NachoPal/fixowl/blob/main/LICENSE)
