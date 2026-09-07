---
status: accepted
date: 2026-09-06
decision-makers: [fixowl captain]
---

# 0002. Add a GitHub App installation-token runtime credential with native auto-refresh

## Context and Problem Statement

fixowl's night run pushes branches, opens PRs, and reads CI state with a
**runtime credential**. Today that is a fine-grained PAT. But GitHub exposes no
grantable "Checks" permission to fine-grained PATs, so the
[CI-gated fix loop](../ci-fix-loop.md) cannot read check-run status and
**degrades** - it opens the PR after a settle window instead of verifying CI.
Making the gate actually verify CI requires a credential that can read Checks: a
GitHub App installation token (or a classic token).

The complication is lifetime. A fixowl night runs under `timeout-minutes: 300`
(up to 5 hours) and pushes/reads throughout, but a GitHub App **installation
access token expires ~1 hour after it is minted**. Any design that produces one
token and reuses it would 401 on every push and API call after the first hour,
breaking the night. So the question is not just "support an App" but "how is the
1-hour token kept fresh across a multi-hour, unattended run with no human in the
loop?"

## Decision Drivers

- The CI gate must be able to actually verify check runs (read Checks).
- A multi-hour night must never run on a dead credential; refresh must be
  automatic and unattended.
- Backward compatibility: the existing fine-grained PAT path must stay unchanged
  and remain the quick-start tier.
- Preserve the hard invariants: no merge capability, no Administration **write**
  on the runtime credential, the coding agent holds no token, the git dir never
  enters a container.

## Considered Options

1. **Keep PAT-only.** Accept that CI is never truly gated.
2. **In-workflow mint** (`actions/create-github-app-token`): a workflow step mints
   an installation token once and feeds it to the action as the existing token
   env var.
3. **Native App auth with `@octokit/auth-app`:** the action constructs its runtime
   Octokit from the App's durable inputs (app id + private key + installation id);
   the auth strategy mints the installation token on first use and re-mints it
   near expiry on every later call. The git edge takes a token *provider callback*
   that asks the same strategy for the current token before each fetch/push.

## Decision Outcome

Chosen option: **3 - native App auth with `@octokit/auth-app`**, added *alongside*
the fine-grained PAT (config enforces `runtime_token` XOR `app`; runtime selection
is by which secrets the workflow injects).

Option 1 leaves the product's headline feature (verified CI gating) permanently
best-effort. Option 2 is rejected as a default because its token still dies of its
own 1-hour expiry long before a 5-hour night ends (and `create-github-app-token`
even auto-revokes at job end) - it would 401 mid-night and can leave orphaned
branches and half-opened PRs, strictly worse than the honest PAT degrade. Option 3
refreshes the token transparently for the whole night with zero human action:
the strategy caches the token in memory and re-mints it near expiry, so a push
four hours in gets a fresh token. Option 2 is retained only as a *documented
escape hatch* for single jobs known to finish under an hour.

### Consequences

- Good: the CI gate becomes real on the App tier - a green head flips a draft PR
  to ready, a red one keeps it a draft and retries - because the installation
  token can read Checks.
- Good: the ~1h expiry is handled with no human intervention and no in-workflow
  re-mint; a unit test drives a simulated >1h night and asserts a fresh token is
  minted after the first expires.
- Good: fully backward compatible - the PAT path is byte-for-byte unchanged and
  stays the quick-start tier; every new config field is optional.
- Bad / accepted cost: one new dependency (`@octokit/auth-app`, bundled into the
  action) and a non-obvious key-format requirement - WebCrypto needs **PKCS#8**
  while GitHub downloads **PKCS#1**, so `fixowl provision` must normalize the key.
- Bad / accepted cost: the git edge had to change from a single static token to a
  token *provider callback* called per command - the load-bearing change that
  keeps a refreshed token current on the wire.
- Neutral: App-authored PRs/comments come from the App's `[bot]` identity rather
  than a human (cleaner audit); like the PAT and unlike `GITHUB_TOKEN`, they still
  trigger the target repo's own CI.

## Confirmation

- A unit test constructs the app-auth strategy with a fake token minter and a
  fake clock, drives the push-token provider across a simulated >1-hour night,
  and asserts a second mint occurs after the first token expires
  (`packages/action/src/runtime-octokit.test.ts`).
- A git-ops test asserts the token provider is consulted before *each* git
  command (not captured once), so a refreshed token reaches the wire
  (`packages/action/src/git-ops.test.ts`).
- Config-load enforces `runtime_token` XOR `app`; `fixowl validate` confirms the
  App authenticates, holds `Checks: read`, and is installed on each repo.
- `no-merge.test.ts` still passes: no merge capability was added.

## More Information

- [docs/app-auth.md](../app-auth.md) - the full App tier setup, key format, and
  the in-workflow-mint escape hatch.
- [docs/security.md](../security.md) and [docs/ci-fix-loop.md](../ci-fix-loop.md).
- Builds on the CI-gated fix loop; does not supersede any accepted ADR.
