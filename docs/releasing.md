# Releasing

fixowl ships two artifacts from a single manual workflow,
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

- the **`fixowl` npm CLI** (`packages/cli`), published to public npm, and
- the **GitHub Action**, released as a git tag + GitHub Release running from the
  checked-in bundle `dist/action/index.js` (consumed as `uses: NachoPal/fixowl@vN`).

`@fixowl/core` and `@fixowl/action` are private and are never published.

## The model: the version in the code is the source of truth

The workflow **never bumps or commits a version**. You edit the version by hand,
commit it, then trigger the workflow, which ships exactly that version. The
single version lives in **two files that must stay in lockstep**:

- `packages/cli/package.json` `version` - the source of truth, and
- the root `package.json` `version` - kept identical by you.

The workflow reads the version from `packages/cli/package.json`, verifies the
root matches, and **fails loudly if they diverge**. The channel (stable vs
prerelease) is derived from the version string itself by
[`scripts/release-channel.ts`](../scripts/release-channel.ts) (unit-tested in
`release-channel.test.ts`).

## Cutting a stable release

1. Set both versions to the same plain semver number (e.g. `0.2.0`):

   ```sh
   # edit packages/cli/package.json and package.json -> "version": "0.2.0"
   git commit -am "release: 0.2.0"
   git push
   ```

2. Trigger the workflow: Actions -> **release** -> **Run workflow** (or
   `gh workflow run release.yml`). Leave `dry_run` unchecked.

The run lints, tests, builds (failing if the committed `dist/action` bundle is
stale), verifies the versions match, checks the version is not already on npm
and the tag does not already exist, then:

- `npm publish --access public --provenance --tag latest` from `packages/cli`,
- creates and pushes git tag `v0.2.0`,
- force-moves the floating major tag `v0` to this commit (so
  `uses: NachoPal/fixowl@v0` tracks the latest stable release), and
- creates a full (non-prerelease) GitHub Release with auto-generated notes.

## Cutting a prerelease (release candidate)

Use a semver **prerelease suffix**, e.g. `0.2.0-rc.1`. Set both versions to it,
commit, push, and run the workflow the same way. The prerelease channel:

- publishes under the npm **`rc`** dist-tag (`npm publish --tag rc`) - it does
  **not** touch `latest`,
- creates git tag `v0.2.0-rc.1` but does **not** move the floating `v0` tag, and
- marks the GitHub Release as a **prerelease**.

Install a candidate with:

```sh
npm install fixowl@rc      # or npm install -g fixowl@rc
```

`npm publish` writes to `latest` unless `--tag` is passed, so this prerelease
detection is the only thing protecting the stable channel - any prerelease
suffix (`-rc.N`, `-beta`, `-alpha.1`, ...) is treated as a prerelease.

## Promoting an RC to stable

When a candidate is good, cut a stable release with the final version:

1. Set both versions to the plain number (e.g. `0.2.0`), commit, push.
2. Run the workflow. This publishes `0.2.0` to `latest`, moves `v0`, and cuts
   the full Release.

Publishing is immutable - you cannot retag the existing `0.2.0-rc.1` artifact as
`latest`; you publish a fresh `0.2.0`. (If you ever need to point the dist-tag at
an already-published version without republishing, that is a manual
`npm dist-tag add fixowl@<version> latest`, outside this workflow.)

## Dry run

Check `dry_run` when triggering to run everything - lint, test, build, freshness
guard, version verification, preflight, and channel decision - **except** the
`npm publish`, the tag pushes, and the Release creation. The run prints the plan
it would have executed to the job summary. Use it to validate a version bump
before shipping.

## Required secret

The workflow authenticates to npm with an **`NPM_TOKEN` repository secret** (an
npm automation token with publish rights to `fixowl`). Add it under **Settings ->
Secrets and variables -> Actions -> New repository secret**, name `NPM_TOKEN`. The
workflow writes the `.npmrc` auth line itself; the token is never committed. The
GitHub Release and tag pushes use the built-in `GITHUB_TOKEN` (the workflow
grants it `contents: write`); no extra secret is needed for those.
