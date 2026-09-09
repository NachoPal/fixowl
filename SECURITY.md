# Security policy

fixowl runs an LLM coding agent unattended, overnight, against issues that -
on a public repo - anyone can file. This is the trust model a prospective user
should read before granting any token. For the full design rationale and the
threat model behind each decision, see [docs/security.md](docs/security.md);
this page is the summary GitHub surfaces in the repo's Security tab.

## No server, no handoff

fixowl is a **local CLI + your own self-hosted runner**. There is no
fixowl-operated service anywhere in the path: your GitHub tokens and your
coding-agent credential (e.g. `CLAUDE_CODE_OAUTH_TOKEN`) flow from your own
machine directly to GitHub and to your agent vendor's API. Nothing you
configure is ever sent to, or held by, infrastructure fixowl operates - there
isn't any.

## The hard invariants

These hold regardless of config, and several are enforced by tests that fail
CI if weakened (see [AGENTS.md](AGENTS.md) for the authoritative list):

- **fixowl never merges a pull request.** No code path calls a GitHub merge
  API; a grep-based test (`no-merge.test.ts`) keeps it that way. Every fix
  lands as a PR for a human to review - that review is the actual gate.
- **The coding agent never holds a GitHub token.** Only an explicit allowlist
  of env vars (the agent's own credential, nothing GitHub-shaped) enters the
  per-issue container. Commits and pushes happen on the host, outside any
  container, using the runtime credential below.
- **The `.git` directory never enters a container.** It is moved out of the
  workspace for the night; containers only ever see a git-less working tree,
  and every host git command names the git dir explicitly. A `.git` an
  injected agent plants in the workspace is inert.
- **Issue bodies (and CI output fed back to the agent) are untrusted input.**
  They enter prompts only inside `<untrusted-issue-body>` /
  `<untrusted-ci-output>` fences, with the assumption that fencing alone can
  fail - the container and no-token invariants above are the real backstop.
- **Exactly one level of containerization.** The runner itself is native;
  it calls `docker run` once per agent/verify step. Nothing inside a
  container ever invokes Docker - no socket mounting, no nested runs.
- **Containers run non-root, locked down, and bounded.** Every `docker run`
  uses the host runner's uid/gid, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, a pids limit, a memory limit, and a
  hard timeout with forced removal. No docker socket is ever mounted in.

## The runtime credential

The identity that pushes branches and opens PRs during the night is a
**GitHub App installation**, not a personal access token: its write access is
limited to Contents, Pull requests, and Issues, plus optional read-only
Checks/Commit statuses/Actions/Administration so the CI-gated fix loop can
verify a build went green before marking a PR ready. It never carries
Administration **write**. See [docs/app-auth.md](docs/app-auth.md).

## Admin-token guidance

Setup (`fixowl provision`) uses a separate, **setup-only** fine-grained
personal access token, scoped to only the repos you're onboarding. It is
spent once - to seal secrets, open the provisioning PR, and register the
runner - and is not needed for nightly operation afterward:

- Create it scoped to the target repositories only, not "all repositories."
- After `fixowl provision` succeeds, **revoke it**, or downgrade it to
  Administration: read-only if you want `fixowl status` to keep confirming
  the runner is online.
- Routine `fixowl start` and the nightly run use no admin token at all; both
  soft-fail (rather than error) their online check if the token is later
  revoked or downgraded.

See [docs/security.md](docs/security.md#tokens) for the full permissions
table and rationale.

## If you don't want to grant an admin token

Registering the self-hosted runner is the one step that needs
Administration: write, and it is isolated to `fixowl provision` /
`fixowl start --register`. If you'd rather not hand the CLI a token with
write access at all, register the runner by hand instead:

1. Create the GitHub App yourself and install it on the target repo(s) - see
   [docs/app-auth.md](docs/app-auth.md#manual-app-setup-advanced) for the
   manual (no-manifest-flow) steps.
2. Add the self-hosted runner from the repo's Settings > Actions > Runners
   page, following GitHub's own registration flow, on the host set up per
   [docs/host-bootstrap.md](docs/host-bootstrap.md).
3. Add the labels, workflow file, and `.fixowl.yml` from
   [templates/](templates/) directly, instead of via `fixowl provision`.

This path costs you the one-command convenience, not any security property:
the resulting night run has the exact same runtime credential and invariants
as one provisioned through the CLI.

## Reporting a vulnerability

If you find a security issue in fixowl itself (not in a repo fixowl is
operating on), please report it privately rather than filing a public issue:
open a [GitHub Security Advisory](../../security/advisories/new) on this
repository ("Report a vulnerability" under the Security tab). Include repro
steps and the version/commit you tested. We'll acknowledge within a few days
and coordinate disclosure once a fix is available.
