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
  `start` path, and never grant the runtime credential any Administration
  **write** (or other write beyond Contents/Pull requests/Issues). The CI-gated
  fix loop adds read-only Checks/Commit statuses/Actions/Administration to the
  runtime credential so it can read check runs, required checks, and CI logs
  (when check-run status still cannot be read, e.g. an App missing Checks: read,
  the gate degrades - settle then ready, with a loud warning); that read-only
  Administration is the only Administration the runtime credential ever holds. The runtime credential is **a GitHub App installation, and nothing
  else**: config requires the `app` block, and the old `runtime_token` key (a
  fine-grained PAT, which cannot read Checks and so made the CI gate a silent
  no-op) is rejected at load with a migration message
  (`RUNTIME_TOKEN_REMOVED_MESSAGE`); the action likewise refuses a workflow that
  still injects only the old `FIXOWL_GITHUB_TOKEN` secret
  (`resolveRuntimeCredentialFromEnv`). Do not add a PAT runtime path back. The
  action constructs its Octokit with `@octokit/auth-app`
  (`packages/core/src/runtime-credential.ts`,
  `packages/action/src/runtime-octokit.ts`) so the ~1h installation token
  **auto-refreshes** across the multi-hour night. The git edge takes a token
  **provider callback** (`GitWorkspace`, `git-ops.ts`), called before each
  fetch/push, so a token refreshed mid-night is always current on the wire. The
  App private key is sealed as **PKCS#8** (`toPkcs8Pem`,
  `packages/cli/src/github/app-key.ts`); WebCrypto rejects GitHub's PKCS#1. See
  [docs/security.md](docs/security.md), [docs/ci-fix-loop.md](docs/ci-fix-loop.md),
  [docs/app-auth.md](docs/app-auth.md), and ADR 0003.

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

- `fixowl edit [repo]` (`packages/cli/src/commands/edit.ts`) is the interactive
  config-update path (keep-or-change per-repo, then an optional `noRegister`
  provision hand-off). It shares the per-repo question block with `init` via the
  exported `promptRepoSettings`/`stepModelSelection` (`init.ts`) - `init` passes
  sticky-last prefills, `edit` passes `resolveRepoSettings`; `stepModelSelection`
  is byte-for-byte unchanged when its `current` arg is undefined (init's path).
  Write-back is **surgical**: it mutates a `parseDocument` Document so comments
  and untouched keys survive, writes only changed fields, drops a per-repo key
  when the new value equals the resolved default, and re-validates before
  overwriting. Never route `edit` through `renderConfigYaml` (a lossy fresh-file
  renderer, kept strictly init-only). `edit` is config, not re-onboarding: no
  App/token/runner setup.
- `fixowl provision --manual` (`packages/cli/src/commands/provision-manual.ts`)
  is the no-admin-token provisioning path: it renders the workflow,
  `.fixowl.yml`, and issue template with the exact same renderers
  `provisionCommand` uses (so the two can never drift), writes them under
  `./fixowl-manual/<repo>/`, and prints `gh` steps instead of calling the
  GitHub API - it never touches `ctx.admin`. Extend both commands together if
  provisioning grows a new artifact.
- App onboarding (`fixowl init`) is GitHub's App Manifest one-click flow: pure
  manifest + rationale logic in `packages/cli/src/github/app-manifest.ts` (its
  permissions must stay in lockstep with init's `verifyApp`, `fixowl validate`,
  and the rationale table in docs/app-auth.md), the loopback code catcher in
  `manifest-server.ts`, and Installation-ID auto-detection in
  `app-installations.ts`. Manual App creation is only an advanced footnote in
  docs/app-auth.md - never reintroduce it as a second co-equal onboarding path
  (the Tier-1 lesson), and there is no API for the App avatar (manual upload of
  `assets/fixowl-app-avatar.png`, optional).
- Commits are authored as the installed App's real bot identity (`<slug>[bot]`
  with the `<id>+<slug>[bot]@users.noreply.github.com` no-reply email), resolved
  at night start by `resolveAppBotIdentity` (`packages/action/src/app-identity.ts`)
  from `apps.getAuthenticated` (app JWT, GET /app) + a public `GET /users/<slug>[bot]`
  read - no new scope, best-effort (warn + fall back to `FIXOWL_DEFAULT_GIT_IDENTITY`,
  never abort the night). It threads through `NightInputs.gitIdentity` into
  `GitWorkspace::configureIdentity` alongside the token provider; `gpgsign` stays
  false (unattended runs must not hang on host signing, so commits are attributed
  but never Verified). `isFixowlBranchTip` (`packages/core/src/branch-ownership.ts`)
  is App-identity-aware: it accepts the resolved App bot email AND the legacy
  `fixowl-bot@...` (issue #69 mixed-version compat), with the `fix #<n>:` subject
  as the safety net. Don't hardcode the per-App slug/id or drop the email signal.
- The container name format (`fixowl-<repo>-<issue|classify>-<purpose>`) is owned by
  `packages/core/src/container-naming.ts` (`containerName`, `containerNamePrefix`,
  `parseContainerName`). The action re-exports `containerName` from `container-exec.ts`;
  the CLI's `watch` command discovers live containers via the same helpers. Do not
  re-derive the slug shape anywhere else.
- Actions in workflows are SHA-pinned with a `# vN` comment. Workflows get minimal
  `permissions:`. actionlint runs in CI over both our workflows and rendered templates.
- Spawn processes with argv arrays, never shell string interpolation.
- Keep modules pure where possible; push I/O to the edges behind `deps.ts` interfaces.
- The native `claude` adapter authenticates two mutually exclusive ways -
  `CLAUDE_CODE_OAUTH_TOKEN` (subscription) or `ANTHROPIC_API_KEY` (metered API).
  Its default allowlist lists both, but `ANTHROPIC_API_KEY` WINS over the OAuth
  token in headless `claude -p` mode, so `fixowl init` writes an **exclusive**
  per-agent env override (exactly one) via the `chooseClaudeAuthEnv` prompt -
  never let both reach a container. The credential decides billing
  (`agentBilling(agent, env)`) and thus which run-budget cap applies. Neither is
  a GitHub credential, so both stay off `FORBIDDEN_AGENT_ENV`. codex is API-key
  only (its ChatGPT-subscription OAuth-file path is still unsupported).
- The valid model ids and effort levels per agent live in one place,
  `packages/core/src/agent-catalog.ts`; init, validation, and the adapters all
  read it. Extend an agent there rather than hardcoding a model list elsewhere.
  Per-issue model/effort resolution is pure logic in
  `packages/core/src/model-selection.ts`. The catalog is the safety-net fallback,
  not the last word: `fixowl validate` also checks each chosen model against the
  provider's LIVE model list via the agent-aware source in
  `packages/core/src/model-list.ts` (mirrors `agent-usage.ts` - pure parser +
  injected `fetchJson`; `getModelListSource(agent)` gives codex/OpenAI the free
  `GET /v1/models` read and returns undefined for claude so it keeps the
  catalog alone). Fail-open by contract (`liveModelCheck`): an unreachable list
  warns and defers to the catalog, only a fetched-but-missing model hard-fails
  validate. Add a new provider's source there. `init` still picks from the
  catalog (live enrichment is a follow-up); the night RUN does no live check.
- The scheduling trigger is a first-class per-repo choice
  (`schedule_trigger` in `config-schema.ts`, a `fixowl init` prompt), resolving
  to one of three modes via `resolveRepoSettings` (unset -> `both`, which
  preserves the pre-choice behavior). `hostSchedulerRole`/`workflowHasSchedule`
  (also `packages/core/src/config-schema.ts`) are the pure derivations every
  caller reads: `github-cron` keeps the workflow cron and installs NO host agent;
  `host-scheduler` (recommended) renders a dispatch-only workflow and the macOS
  launchd agent dispatches it **directly on schedule** (primary role, gap 0);
  `both` keeps the cron AND runs the launchd agent as the cron **fallback**.
  `provision.ts` threads the mode into `renderFixowlWorkflow`'s nullable
  `schedule` (via `workflowHasSchedule`; the legacy `--no-schedule` flag still
  forces omit). The host agent's per-repo decision is role-driven in
  `fallback.ts`: primary -> `decidePrimaryDispatch`, fallback ->
  `decideFallbackDispatch`, `github-cron` -> never dispatch / never install
  (issue #81); pure decisions plus the once-a-day slot guard `guardScheduledSlot`
  (the action runs at night start) live in
  `packages/core/src/fallback-dispatch.ts`, launchd/plist + DST-safe timing in
  `packages/cli/src/runner/fallback-launchd.ts`. Modes 2/3 use the
  least-privilege `FIXOWL_FALLBACK_TOKEN` (Actions: write only) so the admin
  token stays setup-only and revocable. The `promptScheduleTrigger` helper
  (`init.ts`) takes a current-value prefill so the future `fixowl edit` command
  reuses it. See [docs/local-fallback.md](docs/local-fallback.md).
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
  *required* checks -> green flips the draft PR to ready, a red check feeds the
  failures back and retries, up to `ci_max_tries`, then leaves an annotated
  draft. Only an actionable red retries: a `stalled` required context (never
  registers, `requiredContextsStalled` in `ci-gate.ts`) or a bare timeout with
  nothing red stops early, and any failure after the draft PR exists annotates
  and keeps that draft rather than stranding it (issues #72/#74/#75/#76; the poll
  absorbs a transient read error per #73). The pure gate decision is
  `packages/core/src/ci-gate.ts`; the poll loop is `ci-poll.ts` (inject a `Clock`
  in tests); `getRequiredChecks`/`getChecksForRef`/`getFailedCheckLogs` live
  behind `deps.ts`. Config is `ci_max_tries` (3) /
  `ci_timeout_minutes` (60) in `config-schema.ts`, propagated through
  `provision` -> `action.yml` inputs. See [docs/ci-fix-loop.md](docs/ci-fix-loop.md).

- Pre-work issue triage is two layers between selection and the agent, both
  default ON and free. Layer A (the deterministic pre-gate, `triage.ts::planTriage`
  + the read-only `getIssueTriageSignals` edge) runs on the fresh set before the
  `max_issues` cap: one aliased GraphQL round-trip (the `getIssueDependencies`
  technique, one rate-limit point) reads each issue's own cross-reference graph -
  never a PR scan - and skips only GitHub's high-precision signals
  (`reduceTriageNode`): a closing-keyword-linked merged PR (`skip_already_fixed`)
  or a marked/`duplicate`-labeled duplicate (`skip_duplicates`). A **bare** merged-PR
  cross-reference is deliberately NOT skipped (the verified #136 false-positive) -
  it is left to Layer B. Layer B (`verify_before_fix`, in `processIssue`) prepends
  the verify-first prompt (`VERIFY_FIRST_INSTRUCTION`, first pass only); the agent
  emits a verdict to stdout (`parseVerdict` - never a workspace file, which would
  defeat `hasChangesAgainst`) and **never touches GitHub** (the token invariant).
  The HOST reads the verdict + diff: a no-diff run opens NO PR and instead does
  `createIssueComment` + `addLabels(['fixowl:triaged'])` (the one new write edge),
  reported under `## Triaged out` (`NightSummary.triaged`, disjoint from the
  branch-exists `skipped`). The `fixowl:triaged` label is the comment-once /
  cross-run marker (selection excludes it; GitHub is the only state). Config keys
  resolve `repo > defaults > built-in on` and the workflow renders an input only on
  opt-out (default-on stays byte-for-byte). See [docs/issue-triage.md](docs/issue-triage.md).

- Priority-label selection is opt-in and OFF by default (an unset `priority`
  block selects exactly as before - list all, oldest-first, cap). Pure ranking is
  `packages/core/src/priority.ts` (`priorityTiers`, `priorityRank`,
  `comparePriority`, mirroring the label-rule helpers); the bounded I/O
  orchestrator is `packages/action/src/priority-selection.ts`. When enabled it
  fills the cap highest-priority-first by paging each tier's
  `labels=<pickup>,<tier>` AND-query oldest-first via the NEW **bounded**
  `listOpenIssuesPage` edge (one page, NOT `octokit.paginate`), so the fetch is
  O(cap) not O(backlog). Each fetched page runs through the SAME `resolveWork`
  closure the default path uses (branch idempotency + Layer A), so those never
  drift - priority only changes WHICH issues fill the cap and in what order. It
  does NOT override `blocked_by`: Layer 1 (`prereq-planner.ts`) keeps ordering
  authority, and priority is only its topo TIEBREAK (threaded as an optional
  `PrioritySettings`; off == oldest-first, so existing tests are unaffected), so a
  low-priority prerequisite still precedes its high-priority dependent
  ("prerequisites always win"). `include_unlabeled` (default on) makes
  un-prioritized issues the lowest tier. Config resolves `repo > defaults`
  (unset == off, NOT default-on like triage); the workflow renders the inputs only
  when enabled; `provision` creates the labels via `PRIORITY_LABEL_META`. See
  [docs/priority-selection.md](docs/priority-selection.md).

- Run budgets (issue #21) bound the night with a set of independent,
  each-optional stop conditions - count (`max_issues_per_run`), usage %
  (`usage_budget_percent`), total tokens (`total_token_budget`), graceful
  wall-clock (`run_budget_minutes`) - and the run stops on the first that trips.
  The trip/no-trip and first-trip-wins logic is pure in
  `packages/core/src/run-budget.ts` (fixed order count -> usage -> tokens ->
  wallclock); `main.ts` assembles the state snapshot and evaluates it at two
  gates (pre-run, and between-issues at the top of the inner loop). Keep the
  conditions pure and keep state assembly the only I/O, so parallel chains (#36)
  only have to make the snapshot consistent. Two spend axes, split by billing:
  usage % is for **subscription** agents and is read **out-of-band** on the host
  behind the model-agnostic `UsageReader` (`agent-usage.ts`, selected by
  `getUsageReader(agentName)`); `total_token_budget` is for **API-credit** agents
  and is measured **in-band** - `main.ts`
  accumulates each finished
  issue's `IssueResult.usage`, parsed from the agent's own captured output by
  `getSpendMeter(agentName)` (`agent-spend.ts`, the pure counterpart to
  `agent-usage.ts`; `parseCodexUsage` sums `codex exec --json`
  `turn.completed.usage`, so the codex adapter passes `--json` in **fix** mode
  only). Codex is the only in-band-metered agent today: claude on
  `ANTHROPIC_API_KEY` accepts the `total_token_budget` cap in config but is **not
  yet enforced in-band** - `getSpendMeter("claude")` abstains fail-open, because
  reading claude's per-run usage needs `claude -p --output-format json` and the
  JSON wrapper would break verify_before_fix's plain-text verdict parse (#143); a
  json-safe claude meter is a documented follow-up. Both spend axes abstain
  fail-open (subscription window unreadable, or spend unmeasurable) so they never
  abort a night count + wall-clock would allow. Denomination is **tokens, not
  dollars** - tokens are what every API-credit agent reports directly, with no
  per-model price table to drift; the `SpendSample` breakdown keeps cached-input
  and reasoning-output counts so a dollar layer could price them later without
  re-plumbing (deliberately not built). Billing type is **auth-aware**, resolved
  in `agent-catalog.ts` (`agentBilling(agent, env)`): claude-on-OAuth is
  `subscription` (usage-% window), claude-on-API-key is `api-credit` (token cap),
  so billing threads the resolved env allowlist, not just the agent name. It
  drives which spend cap `fixowl init` offers.
  `usage_budget_percent`, `total_token_budget`, and `run_budget_minutes`
  have no built-in resolution fallback (unset == opted out), so a pre-#21 config
  is unchanged; the starter values in `FIXOWL_DEFAULTS` are only what `fixowl
  init` writes. `max_issues_per_run` stays the count cap and still bounds how many
  issues are selected/classified. NOTE (open verification): `parseCodexUsage`
  was built to the documented `codex exec --json` output shape; a live codex
  transcript was not captured, so the parser abstains defensively on any
  unexpected shape - confirm the exact envelope against a real run before relying
  on the cap. See the README "Run budgets" section.

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
  end-of-job `fixowl-evidence` upload as the fully-successful fallback, marked
  `continue-on-error` so its intermittent FinalizeArtifact 403 (issue #118) never
  flips the whole run red. Upload is best-effort (a failure is logged, never
  aborts the night); in-process tests
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
  == CI green.
  Coverage gap (stated in each job summary): NOT self-hosted runner registration,
  the launchd fallback, or the scheduled-slot budget guard. This is distinct from
  `scripts/local-docker-e2e.ts` (`pnpm e2e:docker`), an in-process real-docker /
  fake-GitHub run with no network writes.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this
project. Do not repeat what the codebase already shows; point to the
authoritative file or command instead. Prefer rewriting or pruning existing
entries over appending new ones, and keep entries concise.
