# Security model

fixowl runs an LLM coding agent unattended against issues that, on a public
repo, anyone can write. The design assumes prompt injection will eventually
land and makes the blast radius a reviewable diff, nothing more.

## Trust boundaries

```
issue body (untrusted)
  -> prompt fence <untrusted-issue-body> (soft boundary)
  -> per-issue container (hard boundary)
  -> human PR review (the product's actual gate)
```

- Issue bodies enter prompts only as data inside `<untrusted-issue-body>`
  fences, with an instruction to treat them as a problem description only.
  A literal closing fence inside a body is defused.
- The fence is assumed to fail. The structural backstops are what count:
  - The agent container has NO GitHub token. Commits and pushes happen on the
    host, by the harness, after the agent is done.
  - No docker socket, no mounts beyond the workspace (plus a read-only prompt
    file), `--cap-drop ALL`, `--security-opt no-new-privileges`,
    `--pids-limit 512`, `--memory 6g`, and a hard timeout with `docker rm -f`.
  - Worst case: a malicious diff in a PR a human reviews. fixowl never merges;
    there is no merge call anywhere in the codebase, and a grep-test
    (`no-merge.test.ts`) keeps it that way.
- Only collaborators with triage access or better can apply labels, and labels
  gate the queue: strangers can file issues, not schedule them.

## Tokens

Two fine-grained PATs, both scoped to only the target repos:

| token | permissions | lives |
| --- | --- | --- |
| admin | Administration RW, Secrets RW, Contents RW, Workflows RW, Issues RW, Actions RW | CLI machine only (`~/.fixowl/secrets.env`, chmod 600) |
| runtime | Contents RW, Pull requests RW, Issues RW | repo Actions secret `FIXOWL_GITHUB_TOKEN` |

- The runtime PAT (not `GITHUB_TOKEN`) authors PRs so the target repo's own CI
  triggers on them.
- Repo secrets are sealed client-side (libsodium sealed box against the repo
  public key) before the API call.
- The agent credential (e.g. `CLAUDE_CODE_OAUTH_TOKEN`) reaches only the agent
  container, passed as `-e NAME` so values never appear in argv or logs.

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
