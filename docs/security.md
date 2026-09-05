# Security model

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

Two fine-grained PATs (plus one optional third), all scoped to only the target
repos:

| token | permissions | lives |
| --- | --- | --- |
| admin | Administration RW, Secrets RW, Contents RW, Workflows RW, Issues RW, Actions RW, Pull requests RW | CLI machine only (`~/.fixowl/secrets.env`, chmod 600) |
| runtime | Contents RW, Pull requests RW, Issues RW | repo Actions secret `FIXOWL_GITHUB_TOKEN` |
| fallback (optional) | Actions RW only | CLI/runner host only (`~/.fixowl/secrets.env`, chmod 600) as `FIXOWL_FALLBACK_TOKEN` |

- **The admin token is setup-only.** It is spent by `fixowl provision` (labels,
  secrets, workflow) and by runner registration - registration is the only
  step needing **Administration: write**, and it now happens during provision
  (`fixowl start --register` covers registering on a host you did not provision
  on). Once the runner is registered, routine `fixowl start` uses **no admin
  token at all**: it only installs and starts the local service. So after
  provisioning you can **revoke** the admin token, or **downgrade it to
  read-only**, and nightly operation is unaffected.
- Keeping the admin token at **Administration: read** (rather than revoking it)
  buys one thing: the local online check in `fixowl start` and `fixowl status`,
  which lists the repo's runners. That is inherently an Administration read, so
  it cannot be satisfied by the least-privilege runtime token (see below) - the
  honest alternatives are a read-only admin token or confirming the runner in
  the GitHub UI under Settings > Actions > Runners. When the admin token is
  absent or lacks that read, `fixowl start` still installs and starts the
  service and just prints how to confirm online status; it never fails on it.
- The runtime PAT stays least-privilege (Contents / Pull requests / Issues) and
  is **never** granted Administration. It is the most-exposed credential (a repo
  Actions secret injected into the night run), so it holds only what pushing
  branches and opening PRs requires. The online check is deliberately not solved
  by elevating it.
- The runtime PAT (not `GITHUB_TOKEN`) authors PRs so the target repo's own CI
  triggers on them.
- **The fallback token is optional and least-privilege.** The local fallback
  trigger ([local-fallback.md](local-fallback.md)) needs **Actions: write** to
  dispatch the workflow when the cron misses - which the admin token (setup-only,
  meant to be revoked/downgraded) and the runtime token (in-repo, least
  privilege) deliberately do not provide for an always-on host job. Rather than
  keeping a full-admin token live or widening the runtime token, the fallback
  uses its own dedicated PAT holding **only Actions RW** on the target repos,
  stored on the host as `FIXOWL_FALLBACK_TOKEN`. This preserves the
  admin-token-is-setup-only property: with the fallback enabled you can still
  revoke or downgrade the admin token. The workflow's own once-a-day budget guard
  lists runs with the ephemeral `GITHUB_TOKEN` (Actions: read), never this token.
- On the runner, the runtime PAT is injected into git fetch/push commands as an
  env-based `http.extraheader` only. It never appears in argv (`ps`), in git
  error output, or in any file under the workspace or the git dir. The git dir
  is no longer mounted into containers at all (see above), but the extraheader
  discipline stays: nothing credential-shaped is ever written to disk. A test
  asserts all three.
- Repo secrets are sealed client-side (libsodium sealed box against the repo
  public key) before the API call.
- The agent credential (e.g. `CLAUDE_CODE_OAUTH_TOKEN`) reaches only the agent
  container, passed as `-e NAME` so values never appear in argv or logs.
- The agent env allowlist structurally refuses GitHub credential names
  (`FIXOWL_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`): `getAgentAdapter`
  throws, so a workflow or config that names one fails the night loudly at
  startup instead of shipping a token into a container.

## Spend control

The env allowlist is default-deny: an agent adapter (or the `agents:` config
override) names exactly the env vars its container receives. Anything else,
e.g. `ANTHROPIC_API_KEY` or `FAL_KEY` for a repo whose code has paid API
paths, is structurally absent, so those paths fail closed inside the
container. Each night is further bounded by `max_issues_per_run`, the
per-issue timeout, and the agent's own turn limit.

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
