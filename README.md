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

![Setup, once: fixowl provision pushes labels, sealed secrets and the workflow file to your repo on GitHub, and fixowl start installs and runs the self-hosted runner service on the runner host. Every night: the workflow's cron dispatches a job to that runner while your machine is asleep, and the fixowl action selects issues labeled overnight and orders them by the repo's native blocked-by prerequisites (deferring any issue whose prerequisite isn't shipping tonight); issues are otherwise independent by default, with file-conflict grouping an optional, off-by-default step. For each issue it runs the agent in a Docker container with no GitHub token inside, runs a cheap local .fixowl.yml pre-check, then pushes the branch and opens the pull request as a draft. A bounded CI-gated fix loop waits for the base branch's required checks: when they pass the draft flips to ready for review; when they fail or time out the failures are fed back to the agent and it retries, up to ci_max_tries, leaving an annotated draft if the budget is exhausted. In the morning: you review the pull request, and fixowl never merges.](assets/how-it-works.svg)

- **One PR per issue**, branch `issue/<n>-<slug>`. The branch doubles as the
  idempotency marker: reruns never duplicate work, and deleting the branch is
  how you ask for a retry. A PR-less `issue/<n>-*` branch is reset-and-retried
  only when its tip commit proves it is fixowl's own work; a branch you (or
  anyone else) pushed under that name is never deleted - fixowl skips the issue
  and warns instead. See [docs/stacked-prs.md](docs/stacked-prs.md) (Retry
  semantics) for the ownership rule.
- **Triage before it works**: a two-layer gate (both on by default, free)
  keeps fixowl from blindly implementing every labeled issue. Layer A skips an
  issue GitHub already records as fixed (a closing-keyword-linked merged PR) or
  as a duplicate before any agent run; Layer B makes the agent verify against the
  current code first, so an issue that needs no change opens **no** PR. A
  triaged-out issue gets one explanatory comment, the `fixowl:triaged` label (so
  it is never re-scanned), and a line under the night summary's `Triaged out`
  section instead of a PR. Tune with `skip_already_fixed` / `skip_duplicates` /
  `verify_before_fix`. See [docs/issue-triage.md](docs/issue-triage.md).
- **Dependency-aware**: two layers decide branch topology. First, fixowl reads
  the night's issues' native GitHub `blocked-by` edges and enforces them: a
  dependent stacks on and ships after its prerequisite when that prerequisite is
  also shipping tonight (or, if the prerequisite was skipped because its branch
  is already in flight with a live PR, stacks on that existing branch), and is
  otherwise **deferred** (the prerequisite isn't selected, failed to ship, is
  cross-repo, or forms a cycle - deferrals are logged and listed in the night
  summary). Second, an **opt-in** heuristic pass (off by default; enable with
  `heuristic_conflict_ordering: true`) classifies the remaining issues by whether
  they touch the same code and stacks those too, with prerequisites always winning
  over that heuristic; when it is off every non-deferred issue branches from the
  default branch independently. Native `blocked-by` ordering is always-on either
  way. Issues are fixed one at a time - topology, not concurrency. See
  [docs/stacked-prs.md](docs/stacked-prs.md).
- **Verification is a capability, not a mandate**: repos declare checks and
  optional web screenshot targets in `.fixowl.yml`; missing capability
  degrades to "unavailable", and each issue's screenshots/logs land in a
  per-issue `fixowl-evidence-issue-<n>` artifact - uploaded from within the
  action the moment that issue finishes, so a run that is cancelled mid-flight
  (e.g. the self-hosted host sleeps) still keeps the evidence for every issue it
  completed. A combined `fixowl-evidence` artifact is also uploaded at job end
  for the fully-successful case. Every PR opens as a **draft**; the target repo's
  own required CI - not the local `.fixowl.yml` checks, which now run only as a
  cheap pre-filter - is the authority that flips it to ready-for-review in a
  bounded fix loop. See [docs/ci-fix-loop.md](docs/ci-fix-loop.md).
- **Agent-agnostic**: adapters for `claude` (default; on a Claude subscription
  token or an Anthropic API key), `codex`, and a
  deterministic `script` adapter used for e2e tests (test-only: it executes
  issue bodies as shell, so the action refuses it without an explicit
  `FIXOWL_UNSAFE_SCRIPT_AGENT=1` opt-in). Adding one is a two-file change - see
  the guide in [docs/adding-an-agent-adapter.md](docs/adding-an-agent-adapter.md).
- **Cloud-portable by construction**: the generated workflow has no
  `container:` key and no host assumptions; swapping `runs-on` to
  `ubuntu-latest` is the entire migration.
- **Sandboxed and never-merging**: the agent container gets no GitHub token,
  no docker socket, dropped capabilities, and resource limits; pushes happen
  on the host by the harness. See [SECURITY.md](SECURITY.md) for the trust
  model, or [docs/security.md](docs/security.md) for the full design.

### Priority selection

By default fixowl works matching open issues oldest-first, up to
`max_issues_per_run`. Opt into **priority-label selection** and it fills the cap
**highest-priority-first** from a family of ordered priority labels
(`priority: high` / `medium` / `low` by default, names configurable), fetching
roughly the cap **tier-by-tier** instead of the whole backlog - so a large repo
never pulls thousands of issues to keep a handful. It is off unless a `priority`
block is configured, and it never overrides `blocked_by`: a low-priority
prerequisite of a high-priority issue still ships first. See
[docs/priority-selection.md](docs/priority-selection.md).

### Ordering the night

![How fixowl orders one example night into stacked-PR chains. The night's selected issues (#12, #15, #18, #21, #23, #40) flow through two layers of pure planning. Layer 1 reads native GitHub blocked-by edges and is always-on and authoritative: #18 is blocked-by #15 so #15 ships first with #18 stacked under it, while #21 is blocked-by #7 which is not shipping tonight so #21 is deferred with no PR. Layer 2 is a same-file conflict heuristic that is optional and off by default (it runs only when heuristic_conflict_ordering: true is set); the diagram marks it "OPTIONAL - OFF BY DEFAULT" and shows a night with it enabled, where it groups #12 and #23 and predicts #15, #18 and #40 independent. With Layer 2 off (the default) every non-deferred survivor branches independently and only Layer 1 shapes the night. When enabled, the two merge under "prerequisites always win": chain 1 is #12 then #23, chain 2 is #15 then #18 (the blocked-by edge forces the stack the heuristic had split), chain 3 is #40 alone, and #21 stays deferred. Each chain then becomes stacked PRs where every PR targets the previous issue's branch and the first PR of a chain targets the default branch. One PR per issue; fixowl never merges.](assets/issue-ordering.svg)

Two layers of pure planning decide branch topology: native `blocked-by`
prerequisites first (authoritative and always-on - deferring what cannot ship
tonight), then an opt-in same-file conflict heuristic over the survivors (off by
default; enable with `heuristic_conflict_ordering: true`), combined under
"prerequisites always win" into chains whose PRs each stack on the previous
branch. The diagram above marks Layer 2 "optional - off by default" and
illustrates what it does *when enabled*, which is not the default; with it off,
only Layer 1's always-on `blocked-by` ordering shapes the night. Full detail
in [docs/stacked-prs.md](docs/stacked-prs.md).

## Quick start

```sh
npm install -g fixowl
fixowl init          # guided setup, start to finish
```

`init` walks through the whole thing and writes nothing until you have answered:

1. the admin fine-grained PAT plus the **GitHub App** the night run
   authenticates as - created for you in **one browser click** via GitHub's App
   Manifest flow (permissions pre-filled and explained, credentials captured
   automatically; a headless variant covers SSH hosts),
2. the coding agent and its credential,
3. one or more repos: schedule (local `HH:MM`, converted to a UTC cron), how the
   night is triggered (see [Scheduling trigger](#scheduling-trigger)), labels,
   and how many issues a night may take on,

then runs the rest for you and stops with an explanation if a step fails:

```sh
fixowl validate      # tokens, repos, docker engine, agent credentials
fixowl provision     # labels + sealed secrets into each repo, registers the runner
                     # on this host, and proposes the workflow, a starter .fixowl.yml,
                     # and an issue template via PR (never committed to the default branch)
fixowl start         # installs and starts the runner service(s); no admin token needed
```

The admin token is **setup-only**: `fixowl provision` is the only thing that
spends it (registration is the one step needing Administration: write). After
provisioning you can revoke it, or downgrade it to read-only if you want
`fixowl status`/`fixowl start` to confirm the runner is online. Routine
`fixowl start` needs no admin token. Provisioning from a different host than the
runner? Use `fixowl provision --no-register`, then `fixowl start --register` on
the runner host.

Don't want to hand fixowl an admin token at all? `fixowl provision --manual`
renders the same workflow, `.fixowl.yml`, and issue template and prints the
`gh label create` / `gh secret set` commands to run yourself, instead of
calling the GitHub API. See [docs/security.md](docs/security.md).

Those stay available on their own for later changes: to update an
already-configured repo, `fixowl edit [repo]` re-walks the per-repo questions
pre-filled with your current values in a keep-or-change style, writes only what
you changed (comments in `config.yaml` are preserved), and offers to
re-provision - no hand-editing needed. And `fixowl init --non-interactive` just
scaffolds `~/.fixowl/{config.yaml,secrets.env}` for you to fill in by hand.

**The night run authenticates as a GitHub App** (`app` in the config). Its
installation token reads Checks, so the [CI-gated fix loop](docs/ci-fix-loop.md)
is **real** (green flips a PR to ready; red keeps it a draft and retries), and the
~1h token **auto-refreshes** across the whole night - no 1-hour cliff, no human
in the loop. A fine-grained PAT is deliberately not an option: GitHub exposes no
"Checks" scope to PATs, which would make the gate a silent no-op. See
[docs/app-auth.md](docs/app-auth.md).

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
  app:                                    # the GitHub App the night run authenticates as; see docs/app-auth.md
    app_id: 123456
    installation_id: 7890123
    private_key: ${FIXOWL_APP_PRIVATE_KEY}   # base64 of the downloaded App .pem; sealed into repos as an Actions secret
defaults:
  schedule: "37 1 * * *"                  # UTC
  schedule_trigger: host-scheduler        # host launchd dispatches on schedule (recommended for self-hosted);
                                          #   also: github-cron (cron only) | both (cron + host fallback)
  labels: { any: [overnight] }            # any/all combinations supported
  agent: claude
  max_issues_per_run: 4                   # run budget: at most this many PRs ship
  # usage_budget_percent: 85              # run budget (subscription agents): stop at this % of the usage window
  # total_token_budget: 3000000           # run budget (API-credit agents): stop once total token spend hits this
  # run_budget_minutes: 240               # run budget: don't start a new issue after this long
  issue_timeout_minutes: 45               # per-issue safety net (a stuck agent is killed)
  model: sonnet                           # default model when no selector label
  effort: medium                          # default reasoning effort
agents:
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] }   # the ONLY env vars agents ever see
  # codex:  { env: [OPENAI_API_KEY] }          # opt an agent's paid key in explicitly (see below)
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

### Using claude

`claude` (the default) runs Claude Code headlessly in the per-issue container,
and authenticates **one of two mutually exclusive ways** - `fixowl init` asks
which right after you pick the agent:

```yaml
agents:
  # A: a Claude SUBSCRIPTION OAuth token (`claude setup-token`).
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] }
  # B: an Anthropic Console API KEY, billed as metered API usage.
  claude: { env: [ANTHROPIC_API_KEY] }
```

The choice also decides the run budget (see below): the **subscription** token
bills against a rolling usage window, so it is bounded by `usage_budget_percent`;
the **API key** bills per token, so it is bounded by `total_token_budget`.

> **Never both at once.** In headless (`claude -p`) mode Claude Code uses
> `ANTHROPIC_API_KEY` in preference to `CLAUDE_CODE_OAUTH_TOKEN` when both are
> present, so a "subscription" run would silently bill as API usage. fixowl
> avoids this by writing an **exclusive** allowlist - exactly one of the two -
> so only the credential you chose ever reaches the container.

### Using codex

`codex` runs OpenAI's Codex CLI (`codex exec`) headlessly in the same per-issue
container. It holds no credential by default: you opt its API key
into the allowlist explicitly, so no repo starts spending by accident:

```yaml
agents:
  codex: { env: [OPENAI_API_KEY] }   # authenticates codex via the OpenAI API
```

`OPENAI_API_KEY` then rides the same default-deny env allowlist every other
adapter uses (its value never appears in any argv). `codex exec` does not read
that key from the environment, so at the start of each run the adapter runs
`codex login --with-api-key` from the forwarded key to write codex's auth file,
then execs `codex exec` - all inside the same ephemeral, `--rm` container, so the
key is never written to a host disk or an image layer (a missing/empty key fails
the run loudly instead of a silent 401). Models seed as the
`gpt-5-codex` family (`gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`) and
efforts are `minimal`/`low`/`medium`/`high`/`xhigh`; codex takes `-m <model>`
and maps effort to `-c model_reasoning_effort=<level>`. The real model list is
server-provided per account - extend the catalog
(`packages/core/src/agent-catalog.ts`) with any model your key can reach, and
note that not every model accepts every effort level. On top of the catalog,
`fixowl validate` cross-checks each chosen codex model against your account's
live OpenAI model list (a free `GET /v1/models` read), so a bogus or deprecated
id fails validation instead of the night run; the check is fail-open (an
unreachable list just warns and falls back to the catalog).

> **API key only, for now.** This is the OpenAI **API-key** path (billed as API
> usage). Authenticating codex with a **ChatGPT/Codex subscription** is a
> separate, deferred path: that credential is a refreshable OAuth token *file*
> rather than a single env var, so it does not fit the "only allowlisted env
> vars enter the container" model and is not supported yet.

### Run budgets

A night is bounded by a small set of **independent, each-optional stop
conditions**, evaluated at two gates - once before starting (pre-run) and again
before each issue (between-issues). The run stops on the **first** condition
that trips, and the night summary names which:

- **`max_issues_per_run`** - a count cap: at most this many PRs ship in one run.
  The secondary cap, and the only budget that works for agents whose usage is
  not observable. Defaults to 4.
- **`usage_budget_percent`** - for **subscription-billed** agents (`claude`):
  stop before starting a new issue once the agent's rolling usage window is at or
  above this percent. Read out-of-band on the host from the provider (for
  `claude`, the non-billing OAuth usage endpoint, using the token the host
  already holds - nothing new enters the agent container). A read failure is
  *advisory*: it abstains and falls through to the other budgets rather than
  aborting the night. Opted out when unset. Silently no-ops for an API-credit
  agent, which has no such window - use `total_token_budget` instead.
- **`total_token_budget`** - the API-credit counterpart, for **pay-per-token**
  agents (`codex` on `OPENAI_API_KEY`, or `claude` on `ANTHROPIC_API_KEY`): stop
  before starting a new issue once the night's accumulated token spend reaches
  this total. Unlike the usage window, this is measured **in-band** - fixowl
  accumulates the token counts the agent reports in its own output
  (`codex exec --json` `turn.completed.usage`), with no
  provider endpoint to poll (OpenAI's spend API needs an org Admin key and
  buckets by day, unusable for a live gate). Denominated in tokens, not dollars:
  tokens are the one quantity every API-credit agent reports directly, with no
  price table to drift. Abstains (falls through) when the agent's spend is
  unmeasurable this run. Opted out when unset.
  > **codex is the metered agent today.** `claude` on `ANTHROPIC_API_KEY` accepts
  > this cap in config, but it is **not yet enforced in-band** for claude: reading
  > claude's per-run usage needs `claude -p --output-format json`, and that JSON
  > wrapper breaks the plain-text verdict the verify-before-fix triage parses from
  > claude's fix output, so the claude meter abstains fail-open (a documented
  > follow-up). Such a run is still bounded by count and wall-clock.
- **`run_budget_minutes`** - a graceful wall-clock cap: don't *start* a new issue
  after this many minutes. Distinct from the workflow's blunt `timeout-minutes`
  hard-kill ceiling. Opted out when unset.

Each is set in `defaults` and overridable per repo; leave one unset (or delete
its line) to opt that axis out. `fixowl init` prompts for the spend cap that fits
the chosen agent's billing (usage % for subscription, token total for
API-credit) plus wall-clock, count, and the per-issue timeout. The pure gate
logic lives in `packages/core/src/run-budget.ts`; the out-of-band usage read is
behind the model-agnostic `UsageReader` in `packages/core/src/agent-usage.ts`,
and the in-band spend meter behind `SpendMeter`/`getSpendMeter` in
`packages/core/src/agent-spend.ts`.

Each target repo carries a `.fixowl.yml` (proposed by `provision` when
missing) declaring its Dockerfile, verify commands, optional web screenshot
targets, and repo-specific prompt instructions.

**The Dockerfile contract:** fixowl runs the coding agent inside this per-repo
image, so the image must contain the CLI for whichever agent the repo runs, plus
git, your toolchain, and (for web verification) Playwright with chromium:

- `agent: claude` needs the `claude` CLI (`@anthropic-ai/claude-code`).
- `agent: codex` needs the `codex` CLI (`@openai/codex`), and `OPENAI_API_KEY`
  opted into the repo's agent env (the credential rides the config env allowlist,
  never the image).

The samples in **[templates/dockerfiles/](templates/dockerfiles/)**
(`web.Dockerfile`, `electron.Dockerfile`) install **both** the `claude` and
`codex` CLIs, so most repos can copy a sample as-is and run either agent without
hand-writing a Dockerfile. Add any repo-specific build tools your verify commands
need on top.

## Scheduling trigger

GitHub Actions' `schedule` cron is unreliable (it fires late and sometimes skips
a night), and fixowl's primary target is a **self-hosted runner** - so the host
can trigger the night itself, on time. `fixowl init` asks how each repo's night
should be triggered (`schedule_trigger` in the config):

- **`host-scheduler`** (recommended for self-hosted): the workflow is
  dispatch-only and the host's own scheduler dispatches the night directly on
  schedule - reliable timing, no dependence on GitHub's cron.
- **`github-cron`**: the workflow keeps its `schedule:` cron and nothing runs on
  the host. Simplest, but timing is unreliable - mainly worth it on a
  GitHub-*hosted* runner.
- **`both`**: keep the cron *and* let the host dispatch only if the cron run is
  missing (belt-and-braces).

The `host-scheduler` and `both` modes use a dedicated, least-privilege dispatch
token and never start a duplicate run or mask whether the cron works. See
[docs/local-fallback.md](docs/local-fallback.md).

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

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup,
conventions, CI gates, and the hard invariants a change must not break; all
participation is under the [Code of Conduct](CODE_OF_CONDUCT.md).

**The contribution we most want: a new coding-agent or model adapter.** fixowl's
runner is agent-agnostic, so teaching it to drive another agent, CLI harness, or
model subscription is usually a two-file change with its own first-class,
code-grounded guide:
**[docs/adding-an-agent-adapter.md](docs/adding-an-agent-adapter.md).** If your
subscription or model isn't supported yet, that's exactly the on-ramp - or open a
[new-adapter request](https://github.com/NachoPal/fixowl/issues/new/choose).

Good places to start:
[`good first issue`](https://github.com/NachoPal/fixowl/labels/good%20first%20issue)
and [`help wanted`](https://github.com/NachoPal/fixowl/labels/help%20wanted).

## License

MIT
