---
status: accepted
date: 2026-09-08
decision-makers: [fixowl captain]
---

# 0003. Make the GitHub App the sole runtime credential and remove the runtime PAT

## Context and Problem Statement

ADR 0002 added a GitHub App installation token as a runtime credential
*alongside* the original fine-grained PAT (`runtime_token`), keeping the PAT as
a "quick-start tier" for backward compatibility. That left fixowl with two
runtime credentials selected by config (`runtime_token` XOR `app`) and by which
secrets the workflow injects.

The PAT tier has a structural flaw: GitHub exposes no grantable "Checks"
permission to fine-grained PATs, so on a PAT the
[CI-gated fix loop](../ci-fix-loop.md) - fixowl's headline feature - can never
read check-run status. It degrades to a settle-then-ready `unverified` outcome
on every issue, i.e. the gate is a silent no-op. The App path is proven end to
end (the real-call and script-adapter e2e both run on an App token). Keeping the
PAT tier means shipping, documenting, testing, and explaining a mode in which
the product's main promise does not hold.

Supersedes ADR 0002's decision to keep the PAT path alongside the App; the
native `@octokit/auth-app` auto-refresh design from ADR 0002 is retained
unchanged.

## Decision Drivers

- The CI gate must actually verify check runs; a credential on which it cannot
  is not an acceptable default or fallback.
- One runtime credential means one provisioning path, one workflow shape, one
  set of docs, and no XOR logic to keep consistent.
- Preserve the hard invariants: the admin token stays a setup-only fine-grained
  PAT; the optional fallback token stays a separate Actions-write-only PAT; no
  merge capability; no Administration write on the runtime credential.
- A legacy config must fail loudly, never silently run without CI gating.

## Considered Options

1. **Keep both tiers** (status quo from ADR 0002), documenting the PAT degrade.
2. **Keep the PAT path but hide it** (undocumented, off by default).
3. **Remove the PAT runtime path entirely**; the GitHub App is the only runtime
   credential, and a config or workflow that still carries the PAT is rejected
   with a migration message.

## Decision Outcome

Chosen option: **3 - remove the runtime PAT; the App is the sole runtime
credential.** This is a deliberate breaking change.

Option 1 keeps a mode in which the product's headline feature silently does
nothing, and every doc must carry a "unless you are on a PAT" caveat. Option 2
keeps the code and test surface without the honesty of documenting it. Option 3
removes the mode: `github.app` is required, `runtime_token` is rejected at config
load with a message pointing at `docs/app-auth.md`, the generated workflow wires
only the App secret trio, and the action refuses to start on a workflow that
injects only the old `FIXOWL_GITHUB_TOKEN` secret.

### Consequences

- Good: the CI gate is real on every provisioned repo; there is no configuration
  in which it degrades by design (an App missing `Checks: read` is refused by
  `fixowl init` / `fixowl validate` before the night).
- Good: one credential shape end to end - config, `provision`, the workflow
  template, the action's resolver - and the XOR logic, tier prompts, and
  two-tier docs are gone.
- Bad / accepted cost: **breaking change.** Operators on the PAT tier must create
  a GitHub App (~15-20 min) and re-run `fixowl provision`; until they do, config
  load fails with the migration message. Nothing breaks silently.
- Bad / accepted cost: the quick-start on-ramp is ~15 minutes longer than a PAT.
- Neutral: the admin and fallback PATs are untouched; only the *runtime*
  identity changed.

## Confirmation

- `config-schema.test.ts`: `github.app` is required; a `runtime_token` key
  (alone or alongside `app`) fails to parse with the migration message.
- `runtime-credential.test.ts`: the action env resolver names missing App
  secrets and returns a migration error when only `FIXOWL_GITHUB_TOKEN` is set.
- `workflow-template.test.ts` (and its snapshot) and `provision.test.ts`: the
  generated workflow and sealed secrets carry only the App trio.
- `no-merge.test.ts` still passes; the admin and fallback tokens still parse.

## More Information

- Supersedes [ADR 0002](0002-github-app-runtime-credential-with-native-auto-refresh.md)
  (its native auto-refresh design is retained; its "alongside the PAT" clause is
  what this ADR reverses).
- [docs/app-auth.md](../app-auth.md) (setup and the migration note),
  [docs/security.md](../security.md), [docs/ci-fix-loop.md](../ci-fix-loop.md).
