# Security model

See [SECURITY.md](../SECURITY.md) for the user-facing trust model (the policy
GitHub surfaces in this repo's Security tab) and how to report a
vulnerability. This document is the full design rationale behind it.

fixowl runs an LLM coding agent unattended against issues that, on a public
repo, anyone can write. The design assumes prompt injection will eventually
land and makes the write-path blast radius a reviewable diff. What an
injected agent can still read (and therefore leak) is bounded but not zero;
see "Residual risks" at the bottom.

## Trust boundaries

```
issue body (untrusted)
  -> prompt fence <untrusted-issue-body> (soft boundary)
  -> per-issue container (hard boundary)
  -> human PR review (the product's actual gate)
```

- Issue titles and bodies enter prompts only as data inside
  `<untrusted-issue-title>` / `<untrusted-issue-body>` fences, with an
  instruction to treat them as a problem description only. A literal closing
  fence inside either is defused, and titles are collapsed to one line.
- The fence is assumed to fail. The structural backstops are what count:
  - The agent container has NO GitHub token. Commits and pushes happen on the
    host, by the harness, after the agent is done.
  - The git dir never enters any container. `.git` is moved to a sibling of
    the workspace for the whole night, so containers mount a git-less working
    tree, and every host git command names the git dir explicitly
    (`--git-dir`), never relying on discovery. A `.git` an agent plants in the
    workspace is therefore inert: its hooks, `core.fsmonitor`, or rewritten
    remote URLs never execute on the host. Planted `.git` entries are deleted
    at every branch switch and at the end-of-night restore, and the generated
    workflow deletes any leftover `.git` before checkout, so even a hard-killed
    run cannot feed one to `actions/checkout`.
  - No docker socket, no mounts beyond the workspace (plus a read-only prompt
    file), `--cap-drop ALL`, `--security-opt no-new-privileges`,
    `--pids-limit 512`, `--memory 6g`, and a hard timeout with `docker rm -f`.
  - Every container runs non-root, as the host runner's `--user <uid>:<gid>`
    with an explicit writable `HOME`, injected once in `DockerEngine.run`.
    Beyond dropping root, this keeps bind-mount writes to the workspace owned by
    the runner user on Linux, so one issue's files never resist cleanup before
    the next.
  - Worst case: a malicious diff in a PR a human reviews. fixowl never merges;
    there is no merge call anywhere in the codebase, and a grep-test
    (`no-merge.test.ts`) keeps it that way.
- Only collaborators with triage access or better can apply labels, and labels
  gate the queue: strangers can file issues, not schedule them.
- The test-only `script` adapter (issue bodies run as shell, for the zero-spend
  e2e) is refused at action startup unless `FIXOWL_UNSAFE_SCRIPT_AGENT=1` is
  set in the workflow env, and `fixowl provision` refuses to provision a repo
  configured with it.

## Tokens

The **runtime credential** - the identity the night run pushes and calls the API
with - is a GitHub App installation. The admin and fallback tokens are
fine-grained PATs. All are scoped to only the target repos:

| credential | permissions | lives |
| --- | --- | --- |
| admin (PAT) | Administration RW, Secrets RW, Contents RW, Workflows RW, Issues RW, Actions RW, Pull requests RW | CLI machine only (`~/.fixowl/secrets.env`, chmod 600) |
| runtime (GitHub App) | installation token: Contents/Pull requests/Issues: **write**; **Checks: read**; Commit statuses/Actions/Administration: read | app id + installation id + PKCS#8 private key, sealed as repo Actions secrets `FIXOWL_APP_ID` / `FIXOWL_APP_INSTALLATION_ID` / `FIXOWL_APP_PRIVATE_KEY` |
| fallback (optional PAT) | Actions RW only | CLI/runner host only (`~/.fixowl/secrets.env`, chmod 600) as `FIXOWL_FALLBACK_TOKEN` |

A fine-grained PAT is deliberately not accepted as the runtime credential:
GitHub exposes no grantable "Checks" permission to PATs, so the CI-gated fix
loop could never verify check runs on one. A config that still sets the old
`runtime_token` key is rejected at load with a migration message.

- **The admin token is not spent by the automated night run.** Every scheduled
  run pushes and calls the API purely as the GitHub App; it never touches the
  admin token. But "setup-only" needs one qualification if you manage config
  through the CLI - the admin PAT's scopes split into two very different
  lifetimes:
  - **`Administration: write` is the only truly one-time scope.** It is needed
    *only* for **runner registration** (`registerRunner`,
    `packages/cli/src/runner/register.ts`), spent by `fixowl provision` on the
    host you provision on, or by the explicit `fixowl start --register` on
    another host. The default `fixowl start` never registers and needs no admin
    token. Once the runner is registered, nothing ever needs Administration:
    write again, so you can safely **drop it**: revoke the token, or
    **downgrade it to `Administration: read`** (which keeps the
    `fixowl status` / `fixowl start` online-runner check working, see below).
  - **The admin PAT's other write scopes are needed for every CLI
    re-provision, not just first setup.** Editing config through the CLI means
    re-running `fixowl provision`, which regenerates the workflow from
    `~/.fixowl/config.yaml` and **opens or refreshes a PR** carrying it
    (`packages/cli/src/commands/provision.ts`: renders the workflow, upserts it
    to the `fixowl/provision-workflow` branch, opens the PR), and re-runs
    `ensureLabels` / `putRepoSecret` when labels or secrets changed. So a
    CLI-driven config change needs **Contents: write + Workflows: write** (to
    write `.github/workflows/*.yml`) + **Pull requests: write** (the refresh
    PR), plus **Secrets/Issues: write** when those change - all still on the
    admin PAT, none of it Administration: write.
  - Net: **keep the admin PAT** (you may strip only `Administration: write`
    after registration) if you want to keep managing config through the CLI;
    **revoke it entirely** once you are done with CLI-driven config changes. Either
    way the automated night run is unaffected.
- **The admin PAT is setup-only and revocable.** Setup (`fixowl init` /
  `fixowl provision`) needs it once - runner registration is the single step
  that requires `Administration: write` - and routine operation (`fixowl start`,
  `fixowl status`, the automated night run) needs no admin token at all. After
  provisioning you can revoke the PAT entirely (or downgrade it to read-only, see
  below), and re-mint it later only when you want to re-provision through the CLI.
- Keeping the admin token at **Administration: read** (rather than revoking it)
  buys one thing: the local online check in `fixowl start` and `fixowl status`,
  which lists the repo's runners. That is inherently an Administration read, so
  it cannot be satisfied by the least-privilege App (see below) - the honest
  alternatives are a read-only admin token or confirming the runner in the
  GitHub UI under Settings > Actions > Runners. When the admin token is absent
  or lacks that read, `fixowl start` still installs and starts the service and
  just prints how to confirm online status; it never fails on it.
- The App's **write** access stays least-privilege - only Contents, Pull
  requests, and Issues. Its installation token is the most-exposed credential
  (minted inside the night run from repo Actions secrets), so it can push
  branches, open PRs, and comment, and nothing more. The
  [CI-gated fix loop](ci-fix-loop.md) additionally needs to *read* the base
  branch's required checks, the head's check runs, and the failing jobs' logs,
  so the App also carries **read-only** Checks, Commit statuses, Actions, and
  Administration. Administration is **read only**: it lets the loop read
  branch-protection / ruleset required checks, but grants no runner registration
  or protection changes, so the admin-token-is-setup-only property (no
  Administration **write** anywhere but the setup-only admin token) is preserved.
- **Checks: read is why the runtime credential is an App.** GitHub Actions
  **check runs** are read through an API that requires a "Checks" permission,
  which GitHub grants to Apps but does **not** expose to fine-grained PATs (and
  no grantable read substitutes for it). An App installation missing
  `Checks: read` gets a 403 ("Resource not accessible by integration"); fixowl
  treats that the same as "no readable checks": the CI gate **degrades** rather
  than failing the issue - it warns loudly that CI could not be verified and
  flips the draft PR to ready after a short settle window (the same fallback
  used when a repo has no branch protection). `fixowl init` and
  `fixowl validate` refuse an App without `Checks: read` precisely so that
  degrade never happens silently at 2am.
- When the required checks are unreadable (no branch protection, or the read
  scope is missing), the loop likewise falls back to gating on all completed
  checks and logs a warning rather than failing - so under-granting degrades
  gracefully.
- The online check (an Administration *read* of the repo's runners) is still not
  solved by the App: it is deliberately performed with the admin token.
- The App's installation token (not `GITHUB_TOKEN`) authors PRs so the target
  repo's own CI triggers on them.
- **The fallback token is optional and least-privilege.** The host scheduler
  ([local-fallback.md](local-fallback.md)) needs **Actions: write** to dispatch
  the workflow - on schedule in `host-scheduler` mode, or when the cron misses in
  `both` mode - which the admin token (setup-only, meant to be revoked/downgraded)
  and the App (in-repo, least privilege) deliberately do not provide for an
  always-on host job. Rather than keeping a full-admin token live or widening the
  App, the host scheduler uses its own dedicated PAT holding **only Actions RW**
  on the target repos, stored on the host as `FIXOWL_FALLBACK_TOKEN`. This
  preserves the admin-token-is-setup-only property: with the host scheduler
  enabled you can still revoke or downgrade the admin token.
  The workflow's own once-a-day budget guard lists runs with the ephemeral
  `GITHUB_TOKEN` (Actions: read), never this token.
- On the runner, the installation token is injected into git fetch/push commands
  as an env-based `http.extraheader` only. It never appears in argv (`ps`), in
  git error output, or in any file under the workspace or the git dir. The git
  dir is no longer mounted into containers at all (see above), but the
  extraheader discipline stays: nothing credential-shaped is ever written to
  disk. A test asserts all three. The token is fetched from a **provider callback
  immediately before each git command**, not captured once at startup, so the
  installation token (which expires ~1h after minting) is always current even on
  a push hours into the night (see below).

## Runtime credential: the GitHub App

- **The App reads Checks, so the gate is real.** An installation with
  `Checks: read` lets the CI-gated loop verify check runs: a green head flips the
  draft PR to ready, a red one keeps it a draft and retries - discrimination a
  fine-grained PAT can never reach, which is why a PAT is not an option.
- **1-hour token, auto-refreshed, no human in the loop.** A GitHub App
  installation access token expires ~1 hour after it is minted. A single mint at
  job start would 401 on every push and API call after the first hour, breaking
  a multi-hour night. fixowl instead constructs its runtime Octokit with
  `@octokit/auth-app`'s strategy from the durable inputs (app id + private key +
  installation id): the strategy mints the installation token on first use and
  **transparently re-mints it near expiry** on every later API call, and the git
  edge asks that same strategy for the current token before each fetch/push. So
  the token is refreshed for the whole night with zero human action and no
  in-workflow re-mint step (`actions/create-github-app-token` would mint once at
  job start and auto-revoke at job end, capping the night at its 1-hour token).
- **`fixowl[bot]` attribution.** App-authored PRs, comments, and commits come
  from the App's bot identity, not a human (commit attribution detail in
  [docs/app-auth.md](app-auth.md#attribution)). Unlike `GITHUB_TOKEN`, an
  installation token's PRs **do** trigger the target repo's own CI.
- **At-rest secret is the private key.** A leaked installation *token* is bounded
  - it dies within ~1 hour. The sensitive at-rest secret is the App **private
  key** (sealed as `FIXOWL_APP_PRIVATE_KEY`); treat it like the admin token. It
  is stored/sealed as PKCS#8 (GitHub hands out PKCS#1; `fixowl provision`
  normalizes it) and only ever reaches the runner as an Actions secret, never a
  container.
- **Least-privilege write floor.** The App's write is only Contents/Pull
  requests/Issues, plus the read-only Checks/Commit statuses/Actions/
  Administration the gate needs. It never merges (no code path calls a merge
  API) and holds no Administration **write**, so the admin-token-is-setup-only
  invariant is preserved.

See [app-auth.md](app-auth.md) for the full App setup (registration, permissions,
install, and key format).

- Repo secrets are sealed client-side (libsodium sealed box against the repo
  public key) before the API call.
- The agent credential (e.g. `CLAUDE_CODE_OAUTH_TOKEN`) reaches only the agent
  container, passed as `-e NAME` so values never appear in argv or logs.
- The agent env allowlist structurally refuses GitHub credential names
  (`FIXOWL_APP_PRIVATE_KEY`, `FIXOWL_APP_ID`, `FIXOWL_APP_INSTALLATION_ID`,
  `GITHUB_TOKEN`, `GH_TOKEN`): `getAgentAdapter` throws, so a workflow or config
  that names one fails the night loudly at startup instead of shipping a
  credential into a container.

## Spend control

The env allowlist is default-deny: an agent adapter (or the `agents:` config
override) names exactly the env vars its container receives. Anything else,
e.g. `ANTHROPIC_API_KEY` or `FAL_KEY` for a repo whose code has paid API
paths, is structurally absent, so those paths fail closed inside the
container. Each night is further bounded by the layered run budgets (count,
usage %, total tokens, and graceful wall-clock; see the README "Run budgets"
section), the
per-issue timeout, and the agent's own turn limit.

## Workflow action pinning

- The workflow `fixowl provision` renders pins the fixowl action to an
  **immutable commit SHA**, not a mutable ref, so a compromised or force-moved
  upstream tag cannot silently change what runs on the runner. Provisioning asks
  once which version to pin (a single per-run choice for every repo): the
  release this CLI is built from (default - the `v<cli-version>` tag resolved to
  its SHA, so the action matches the CLI), or a specific release/RC tag you type
  (resolved online; a non-existent tag is a hard error, never a silent
  fallback). `--action-version <tag|main>` skips the prompt for automation.
- The **one** exception is the explicit `main` choice, which pins the moving
  `NachoPal/fixowl@main` ref on purpose - for always-latest tracking such as
  fixowl's own self-run repo. A frozen main-HEAD SHA is exactly what goes stale,
  so `main` is left mutable by design; everything else stays SHA-pinned.
- Dev/source-build safety valve: when the CLI's own version has no matching
  published tag (a base version with no `-rc.N` tag, or a local build), the
  default degrades to main HEAD with a note rather than failing. A *typed* tag
  that is not found still hard-fails.

## Runner posture

- Persistent (non-ephemeral) runners on a dedicated machine that hosts only
  Docker and runner infrastructure. Revisit `--ephemeral` if the threat model
  changes (e.g. accepting jobs from forks: do not do that).
- Exactly one level of containerization: the runner is native and calls
  `docker run` once per step; no runner-in-docker, no socket mounting, and
  nothing inside a container ever invokes Docker.

## Residual risks

Accepted and bounded rather than eliminated:

- **Exfiltration.** The agent container needs network egress to reach its own
  LLM API, so a successfully injected agent can send anything it can read to
  anywhere: the mounted working tree (treat private-repo source accordingly)
  and its own credential (e.g. `CLAUDE_CODE_OAUTH_TOKEN`), whose abuse is
  bounded by the agent vendor's spend and turn limits, not by fixowl. An
  egress allowlist proxy is the upgrade path if this matters for your repos.
