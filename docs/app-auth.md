# Runtime credential: the GitHub App

fixowl's night run needs a **runtime credential** to push branches, open PRs,
comment, and read CI state. That credential is a **GitHub App** (`app` in the
config): its installation token reads Checks, so the
[CI-gated fix loop](ci-fix-loop.md) is **real** (green flips a PR to ready; red
keeps it a draft and retries), and the token **auto-refreshes** across the whole
night. `fixowl init` creates the App for you in **one browser click**.

A fine-grained PAT is deliberately not accepted: GitHub exposes no grantable
"Checks" permission to PATs, so on one the gate could never read check-run
status and would silently no-op. The admin token stays a setup-only fine-grained
PAT; only the *runtime* identity is an App.

## Why an App (and why native auto-refresh)

A GitHub App **installation access token expires ~1 hour after it is minted**. A
fixowl night runs under `timeout-minutes: 300` (up to 5 hours) and pushes/reads
throughout. Minting one token at job start (e.g. with
`actions/create-github-app-token`) would 401 on every push and API call after the
first hour.

fixowl instead builds its runtime Octokit **natively** with `@octokit/auth-app`
from the durable inputs (app id + private key + installation id). The strategy
mints the installation token on first use and **transparently re-mints it near
expiry** on every later REST/GraphQL call, and the git edge asks the same
strategy for the current token immediately before each fetch/push. So the token
refreshes for the whole night with **zero human action and no in-workflow mint
step**. A unit test drives a simulated >1-hour night and asserts a fresh token is
minted after the first expires.

## Setup: the one-click manifest flow

`fixowl init` uses GitHub's [App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
it pre-fills the whole App - name, a one-line description, permissions, webhook
off - and opens your browser to GitHub's confirmation page. **Nothing is created
until you review that page and click "Create GitHub App"** (the name and
description are editable there). GitHub
then hands the App ID, slug, and private key straight back to the CLI, which
saves them automatically: the key base64-encoded into `secrets.env`, the App ID
into the config. No permission-ticking, no key download, no base64 by hand.

On an SSH or no-browser host, pick the wizard's **headless** option: it writes
a small `app-manifest.html` you open in any browser (copy it to your laptop
first if needed). After you click "Create GitHub App", the browser is redirected
to a loopback URL (`http://127.0.0.1:9280/…`) and shows **"This site can't be
reached / refused to connect" - that is expected**; nothing runs there. Copy the
full URL from the address bar (it carries the `?code=`) and paste it back into
the terminal. The code lands only in your own address bar, never on the network;
it is single-use and expires **1 hour** after GitHub issues it.

### What the manifest pre-fills, and why

This is the least-privilege justification - for you, or for the org owner
approving the install:

| Pre-filled | Why |
| --- | --- |
| Contents: **write** | push fix branches (fixowl **never merges**; no merge API is ever called) |
| Pull requests: **write** | open one draft PR per issue and flip it to ready when CI is green |
| Issues: **write** | read the labeled issues and comment results back on them |
| Checks: **read** | the CI gate reads check runs, so a PR goes ready only when CI is green |
| Commit statuses: **read** | legacy commit-status contexts count toward the same CI gate |
| Actions: **read** | fetch failing CI logs so the agent can fix a red build |
| Administration: **read** | read which checks branch protection requires (read-only: cannot change settings or register runners) |
| Webhook: **off** | fixowl polls on its nightly schedule; there is no endpoint to host |
| Everything else | **no access** - and the install step below is where you pick which repos it can touch at all |

### Install the App (the one step a manifest cannot do)

The manifest creates the App and its key, but only **you** choose which
repositories it may touch: install the App (the wizard prints the direct
`https://github.com/apps/<slug>/installations/new` link; pick "Only select
repositories"). On an **org**, an org owner must approve the install - the same
policy wall that blocks fine-grained PATs in locked-down orgs (if your target
repos live in an org, tell the wizard so the App is created under that org).
Personal-account installs are self-serve.

Because the CLI now holds the private key, it then authenticates as the App and
**auto-detects the Installation ID** by listing the App's installations - you
are only asked when the listing fails or is ambiguous.

After the App step:

1. **`fixowl validate`** re-checks the App identity, `Checks: read`,
   `Contents: write`, `Pull requests: write`, and that the App is installed on
   each configured repo.
2. **`fixowl provision`** seals `FIXOWL_APP_ID` / `FIXOWL_APP_INSTALLATION_ID` /
   `FIXOWL_APP_PRIVATE_KEY` as repo Actions secrets (the private key normalized
   to PKCS#8, see below) and renders a workflow whose fixowl step env carries the
   trio.

### Optional: give the App the fixowl owl logo

Purely cosmetic, and safe to skip - but if you want the owl branding, it takes
one manual upload. New Apps get a GitHub-generated identicon; there is **no
manifest field and no API** to set an App's logo ([confirmed limitation](https://github.community/t/app-manifest-flow-no-way-to-define-logo/14877)),
so the wizard cannot do it for you and it is the one branding step you do by
hand:

1. Open your App's settings page: `https://github.com/settings/apps/<slug>`
   (the wizard prints this link, or find the App under **Settings ->
   Developer settings -> GitHub Apps**).
2. Under **Display information**, upload
   [`assets/fixowl-app-avatar.png`](../assets/fixowl-app-avatar.png).

That is it - the change is visual only and affects nothing about how fixowl
runs.

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

### Migrating from a runtime PAT

Configs written before the App became the only runtime credential carried a
`runtime_token` key. That key is now **rejected at config load** with a message
pointing here - it is never silently ignored. To migrate: follow the setup above,
replace `runtime_token: ${FIXOWL_RUNTIME_TOKEN}` with the `app:` block, drop
`FIXOWL_RUNTIME_TOKEN` from `secrets.env`, and re-run `fixowl provision` so each
repo's workflow and secrets are refreshed (the old `FIXOWL_GITHUB_TOKEN` repo
secret can then be deleted, and the PAT revoked). A workflow that still injects
only the old secret fails at night start with the same migration message.

## Private-key format (the one non-obvious gotcha)

`@octokit/auth-app` signs the App JWT with WebCrypto, which **only accepts
PKCS#8** (`-----BEGIN PRIVATE KEY-----`). GitHub's downloaded `.pem` is **PKCS#1**
(`-----BEGIN RSA PRIVATE KEY-----`). `fixowl provision` normalizes the key to
PKCS#8 (`toPkcs8Pem`, using Node's built-in `crypto`) before sealing it, so you
can paste whatever GitHub gave you. An OpenSSH-format key is not accepted -
convert it first with `ssh-keygen -p -m PKCS8`.

## Attribution

App-authored PRs, comments, and commits come from the App's `…[bot]` identity,
not a human. Commit authorship is resolved live at night start from the installed
App (`resolveAppBotIdentity`, `packages/action/src/app-identity.ts`): name
`<slug>[bot]`, email `<bot-id>+<slug>[bot]@users.noreply.github.com`, so commits
render with the App's name and avatar. This is attribution only - `commit.gpgsign`
stays false (unattended runs must never hang on host signing), so commits are
authored by the App but not Verified. It is best-effort: a network/read failure
warns and falls back to the legacy `fixowl <fixowl-bot@users.noreply.github.com>`
identity rather than aborting the night. Unlike `GITHUB_TOKEN`, an installation
token's PRs **do** trigger the target repo's own CI.

## Security

The App's *write* is least-privilege (Contents/Pull requests/Issues); its extra
scopes are read-only. It never merges. A leaked installation *token* dies within
~1 hour; the sensitive at-rest secret is the **private key** - treat it like the
admin token. See [security.md](security.md) for the full model.

## Manual App setup (advanced)

You should not need this - the manifest flow above is the supported path, and
it shows everything for review before creating anything. Create the App by hand
only if you must (e.g. adopting an App that already exists): register a new
GitHub App (Settings > Developer settings > GitHub Apps; any unique name, any
homepage URL, webhook **unchecked**), grant exactly the repository permissions
in the [rationale table](#what-the-manifest-pre-fills-and-why) and nothing
else, then install it, generate/download a private key, and base64-encode it
onto one line:

```sh
base64 -i app.private-key.pem | tr -d '\n'
```

The App ID is on the App's settings page ("About"); the Installation ID is the
number in `https://github.com/settings/installations/<id>` - though
`fixowl init`'s "Use an existing App" option auto-detects it from the key for
you and verifies the whole credential either way.
