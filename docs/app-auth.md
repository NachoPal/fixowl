# Runtime credential: the GitHub App tier

fixowl's night run needs a **runtime credential** to push branches, open PRs,
comment, and read CI state. It supports two tiers:

- **Tier 1 - fine-grained PAT** (`runtime_token`). Fastest to set up (~5 min).
  But GitHub exposes no grantable "Checks" permission to fine-grained PATs, so
  the [CI-gated fix loop](ci-fix-loop.md) **cannot read check-run status** and
  degrades (it opens the PR after a settle window instead of verifying CI). Great
  for trying fixowl; not enough to actually gate on CI.
- **Tier 2 - GitHub App** (`app`). ~15-20 min once. The App's installation token
  reads Checks, so the gate is **real** (green flips a PR to ready; red keeps it
  a draft and retries), and the token **auto-refreshes** across the whole night.

Exactly one tier is provisioned per config (`runtime_token` XOR `app`). The admin
token stays a setup-only fine-grained PAT in both tiers; only the *runtime*
credential changes.

## Why an App (and why native auto-refresh)

A GitHub App **installation access token expires ~1 hour after it is minted**. A
fixowl night runs under `timeout-minutes: 300` (up to 5 hours) and pushes/reads
throughout. Minting one token at job start (e.g. with
`actions/create-github-app-token`) would 401 on every push and API call after the
first hour - strictly worse than the Tier-1 degrade, which at least finishes the
night.

fixowl instead builds its runtime Octokit **natively** with `@octokit/auth-app`
from the durable inputs (app id + private key + installation id). The strategy
mints the installation token on first use and **transparently re-mints it near
expiry** on every later REST/GraphQL call, and the git edge asks the same
strategy for the current token immediately before each fetch/push. So the token
refreshes for the whole night with **zero human action and no in-workflow mint
step**. A unit test drives a simulated >1-hour night and asserts a fresh token is
minted after the first expires.

## Setup

1. **Register a GitHub App.** Settings > Developer settings > GitHub Apps > New
   GitHub App (personal or org). Give it any name/homepage. **No webhook** is
   needed (uncheck "Active").
2. **Grant repository permissions** (nothing else):
   - Contents: **Read and write**
   - Pull requests: **Read and write**
   - Issues: **Read and write**
   - Checks: **Read-only** ← the whole point; makes the CI gate real
   - Commit statuses: **Read-only**
   - Actions: **Read-only**
   - Administration: **Read-only** (lets the gate read branch-protection /
     ruleset required checks; grants no runner registration or protection
     changes)
3. **Install the App on your target repos** (the App's "Install App" tab; pick
   "Only select repositories"). On an **org**, an org owner must approve the
   install - the same policy wall that blocks fine-grained PATs in locked-down
   orgs. Personal-account installs are self-serve.
4. **Generate a private key** (the App's General tab > "Generate a private key")
   and download the `.pem`.
5. **base64-encode the key** onto one line so it survives `secrets.env`'s
   line-based `KEY=VALUE` parser:

   ```sh
   base64 -i app.private-key.pem | tr -d '\n'
   ```

6. **`fixowl init`** and choose the **GitHub App** tier. It asks for the App ID
   (App > General), the Installation ID (the number in the install settings URL,
   `.../installations/<id>`), and the base64 key; it verifies the App
   authenticates and holds `Checks: read` before writing the config. Or edit the
   config by hand (see below).
7. **`fixowl validate`** re-checks the App identity, `Checks: read`, and that the
   App is installed on each configured repo.
8. **`fixowl provision`** seals `FIXOWL_APP_ID` / `FIXOWL_APP_INSTALLATION_ID` /
   `FIXOWL_APP_PRIVATE_KEY` as repo Actions secrets (the private key normalized
   to PKCS#8, see below) and renders a workflow whose fixowl step env carries the
   trio instead of `FIXOWL_GITHUB_TOKEN`.

### Config shape

```yaml
github:
  admin_token: ${FIXOWL_ADMIN_TOKEN}
  app:
    app_id: 123456
    installation_id: 7890123
    private_key: ${FIXOWL_APP_PRIVATE_KEY}   # base64 of the downloaded .pem
```

```
# secrets.env
FIXOWL_ADMIN_TOKEN=...
FIXOWL_APP_PRIVATE_KEY=<base64 of app.private-key.pem>
```

`app_id`/`installation_id` are not secrets and live in the config; the private
key is referenced as `${FIXOWL_APP_PRIVATE_KEY}` and resolved from `secrets.env`.

## Private-key format (the one non-obvious gotcha)

`@octokit/auth-app` signs the App JWT with WebCrypto, which **only accepts
PKCS#8** (`-----BEGIN PRIVATE KEY-----`). GitHub's downloaded `.pem` is **PKCS#1**
(`-----BEGIN RSA PRIVATE KEY-----`) and the library does *not* auto-convert.
`fixowl provision` normalizes the key to PKCS#8 (`toPkcs8Pem`, using Node's
built-in `crypto`) before sealing it, so you can paste whatever GitHub gave you.
An OpenSSH-format key is not accepted - convert it first with
`ssh-keygen -p -m PKCS8`.

## Attribution

App-authored PRs and comments come from the App's `…[bot]` identity, not a human.
Like the runtime PAT (and unlike `GITHUB_TOKEN`), an installation token's PRs
**do** trigger the target repo's own CI.

## Escape hatch: in-workflow mint (not recommended)

For a single short cloud run you *can* mint a token in the workflow instead of
provisioning the App natively - add, before the fixowl step:

```yaml
- uses: actions/create-github-app-token@<sha> # vN
  id: app-token
  with:
    app-id: ${{ vars.FIXOWL_APP_ID }}
    private-key: ${{ secrets.FIXOWL_APP_PRIVATE_KEY }}
# then pass steps.app-token.outputs.token into FIXOWL_GITHUB_TOKEN
```

**This token expires in ~1 hour and will 401 on any night longer than that**, and
`actions/create-github-app-token` auto-revokes it at job end. Use it only for
jobs known to finish under an hour. The native path above is the supported way to
run a full night.

## Security

The App holds no more *write* than the Tier-1 PAT (Contents/Pull
requests/Issues); its extra scopes are read-only. It never merges. A leaked
installation *token* dies within ~1 hour; the sensitive at-rest secret is the
**private key** - treat it like the admin token. See [security.md](security.md)
for the full model.
