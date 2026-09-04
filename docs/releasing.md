# Releasing

fixowl ships two artifacts from a single manual workflow,
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

- the **`fixowl` npm CLI** (`packages/cli`), published to public npm, and
- the **GitHub Action**, released as a git tag + GitHub Release running from the
  checked-in bundle `dist/action/index.js` (consumed as `uses: NachoPal/fixowl@vN`).

`@fixowl/core` and `@fixowl/action` are private and are never published.

## The model: the base version in the code is the source of truth

The workflow **never bumps, commits, or pushes a version**. You edit the **base**
version by hand, commit it, then trigger the workflow. The channel and any
prerelease suffix are chosen **at trigger time**, not encoded in the committed
version. The base version lives in a **single source of truth**:

- `packages/cli/package.json` `version` - the only published package's version.

The workflow reads the base version from `packages/cli/package.json`, composes
the published version, and resolves the full plan via
[`scripts/release-channel.ts`](../scripts/release-channel.ts) (unit-tested in
`release-channel.test.ts`). It **fails loudly** on an invalid composed version or
a channel/suffix inconsistency.

## Trigger inputs

Trigger from Actions -> **release** -> **Run workflow** (or
`gh workflow run release.yml -f ...`):

- **`release_type`** (choice, default `release`): the channel -
  `release` (stable), `prerelease`, or `draft` (prepare only, nothing ships).
- **`version_suffix`** (string, default empty): appended **verbatim** to the base
  version to form the published version - base `0.2.0` + `-rc.1` -> `0.2.0-rc.1`;
  empty -> the plain base `0.2.0`. Free-form on purpose (`-rc.1`, `-beta.2`,
  `-alpha.3`, ...). The composed `base + suffix` must be valid SemVer 2.0.0.
- **`dry_run`** (boolean, default false): run everything except the actual npm
  publish, tag push, and Release creation (a validation-only pass).

Every run first lints, tests, and builds (failing if the committed `dist/action`
bundle is stale), then computes the plan.

## Cutting a stable release (`release_type: release`)

The composed version **must be plain** (no prerelease suffix) - the run fails if
`version_suffix` makes it a prerelease. So leave `version_suffix` empty:

1. Set the version to the target plain semver number (e.g. `0.2.0`):

   ```sh
   # edit packages/cli/package.json -> "version": "0.2.0"
   git commit -am "release: 0.2.0"
   git push
   ```

2. Run the workflow with `release_type: release`, `version_suffix` empty.

The run then:

- `npm publish --access public --provenance --tag latest` from `packages/cli`,
- creates and pushes git tag `v0.2.0`,
- force-moves the floating major tag `v0` to this commit (so
  `uses: NachoPal/fixowl@v0` tracks the latest stable release), and
- creates a full (published, "Latest") GitHub Release with auto-generated notes.

## Cutting a prerelease / release candidate (`release_type: prerelease`)

Keep the **base** version at the number you're heading toward (e.g. `0.2.0`), and
pass a **prerelease suffix** at trigger time. The composed version **must** carry
a suffix - the run fails if `version_suffix` is empty.

Run the workflow with `release_type: prerelease` and, e.g., `version_suffix: -rc.1`
(-> `0.2.0-rc.1`). The prerelease channel:

- publishes under an npm dist-tag **derived from the suffix's leading identifier**
  (`-rc.1` -> `rc`, `-beta.2` -> `beta`; falls back to `rc` if the suffix has no
  parseable identifier) - it does **not** touch `latest`,
- creates and pushes git tag `v0.2.0-rc.1` but does **not** move the floating `v0`
  tag, and
- marks the GitHub Release as a **prerelease**.

Install a candidate with the matching dist-tag:

```sh
npm install fixowl@rc      # or npm install -g fixowl@rc
```

Because the channel is chosen at trigger time, the stable channel is protected by
the `release_type=release` consistency check (a suffix there is an error) rather
than by inspecting a committed version string.

## Preparing without shipping (`release_type: draft`)

A `draft` run is a pure prepare/preview: it runs every check but **ships nothing**.
It does **not** publish to npm and does **not** push the `v<version>` git tag or
move `v<major>`. It creates only a **draft** GitHub Release (`gh release create
--draft`), which does not create the public tag until someone publishes the draft.
Use it to stage the target and release notes for review.

## Promoting an RC to stable

When a candidate is good, cut a stable release with the same base number:

1. Ensure the version is the target plain number (e.g. `0.2.0`), commit, push.
2. Run the workflow with `release_type: release` and an empty `version_suffix`.
   This publishes `0.2.0` to `latest`, moves `v0`, and cuts the full Release.

Publishing is immutable - you cannot retag the existing `0.2.0-rc.1` artifact as
`latest`; you publish a fresh `0.2.0`. (If you ever need to point the dist-tag at
an already-published version without republishing, that is a manual
`npm dist-tag add fixowl@<version> latest`, outside this workflow.)

Then bump the base version in `packages/cli/package.json` and root to the next
target (e.g. `0.3.0`) for the following cycle.

## Dry run

Check `dry_run` when triggering to run everything - lint, test, build, freshness
guard, version verification, preflight, and plan computation - **except** the
`npm publish`, the tag pushes, and the Release creation. The run prints the plan
it would have executed to the job summary. Use it to validate a version bump or a
suffix/channel combination before shipping.

## The version applied for publish is ephemeral

For a publishing run the composed version (`base + version_suffix`) is written
into `packages/cli/package.json` in-CI right before `npm publish`
(`npm version <version> --no-git-tag-version --allow-same-version`). This makes no
commit or tag and is **never committed or pushed** - the base version in the repo
stays exactly as you set it.

## npm auth: Trusted Publishing (OIDC)

The workflow publishes to npm via **Trusted Publishing** - no long-lived token.
The publish job runs on a GitHub-hosted runner (`ubuntu-latest`) with
`id-token: write`, and npm mints a short-lived credential over OIDC. Provenance
is generated automatically as part of the same flow.

Configure it once on npm:

1. On [npmjs.com](https://www.npmjs.com/package/fixowl), open the `fixowl`
   package -> **Settings** -> **Trusted Publisher** -> **GitHub Actions**.
2. Set: user/org `NachoPal`, repository `fixowl`, workflow filename
   `release.yml`. (Leave the environment blank - the job uses none.)

That's all the setup required. The **`NPM_TOKEN` repository secret is no longer
needed** and can be deleted under **Settings -> Secrets and variables ->
Actions**. The GitHub Release and tag pushes use the built-in `GITHUB_TOKEN`
(the workflow grants it `contents: write`); no extra secret is needed for those.

> Trusted publishing needs npm >= 11.5.1; the workflow upgrades npm before
> publishing so it works regardless of the version bundled with Node.
