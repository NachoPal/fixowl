/**
 * Release plan logic: the one piece of real decision-making in the release
 * workflow, kept pure and unit-tested here rather than embedded in fragile YAML.
 *
 * The BASE version committed in the code is the source of truth
 * (`packages/cli/package.json`, root kept in lockstep). The workflow NEVER bumps
 * or commits it. The channel and any prerelease suffix are chosen at trigger
 * time via `workflow_dispatch` inputs:
 *
 * - `version_suffix` is appended verbatim to the base version to form the
 *   published version (base `0.2.0` + `-rc.1` -> `0.2.0-rc.1`; empty -> `0.2.0`).
 * - `release_type` is one of `release` (stable), `prerelease`, or `draft`.
 *
 * Any suffix is applied only ephemerally in-CI just before publishing; the base
 * version in the repo is never touched.
 */

/** Strict SemVer 2.0.0 pattern (from semver.org), capturing major and prerelease. */
const SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?<buildmetadata>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The channel chosen at trigger time. */
export type ReleaseType = "release" | "prerelease" | "draft";

export interface ReleasePlan {
  /** The exact version being shipped: base version + `version_suffix`. */
  version: string;
  /** The channel this run targets. */
  releaseType: ReleaseType;
  /** True when the composed version carries a semver prerelease suffix. */
  isPrerelease: boolean;
  /** Whether to `npm publish` at all. False for `draft` (nothing goes live). */
  publishNpm: boolean;
  /**
   * npm dist-tag to publish under (only meaningful when `publishNpm`): `latest`
   * for a stable release, or the prerelease suffix's leading identifier (`rc`,
   * `beta`, ...) for a prerelease, falling back to `rc`.
   */
  npmTag: string;
  /** Immutable per-version git tag, e.g. `v0.2.0-rc.1`. */
  gitTag: string;
  /**
   * Whether to push `gitTag` to origin. False for `draft`, where the tag is
   * created only by the draft Release and stays local to GitHub until published.
   */
  pushGitTag: boolean;
  /** Floating major-line tag (e.g. `v0`) for `uses: NachoPal/fixowl@v0`. */
  majorTag: string;
  /** Whether to force-move `majorTag` to this commit (stable release only). */
  moveMajorTag: boolean;
  /** Whether the GitHub Release is created as a draft (nothing goes live). */
  githubReleaseDraft: boolean;
  /** Whether the GitHub Release is marked as a prerelease. */
  githubReleasePrerelease: boolean;
}

/**
 * Derive the npm dist-tag for a prerelease from its parsed prerelease string:
 * the leading dot-separated identifier (`rc.1` -> `rc`, `beta.2` -> `beta`),
 * falling back to `rc` when that identifier is missing or purely numeric (npm
 * rejects a dist-tag that is a bare number).
 */
function prereleaseDistTag(prerelease: string): string {
  const leading = prerelease.split(".")[0];
  if (leading === undefined || leading === "" || /^[0-9]+$/.test(leading)) {
    return "rc";
  }
  return leading;
}

/**
 * Derive the full release plan from the committed base version, the root version
 * (verified in lockstep), the trigger-time `versionSuffix`, and the `releaseType`.
 * Throws with an actionable message on any of:
 * - cli/root version mismatch,
 * - a composed version that is not valid SemVer 2.0.0,
 * - a `release` whose composed version carries a prerelease suffix, or
 * - a `prerelease` whose composed version has no prerelease suffix.
 * The workflow relies on this to fail loudly before anything is published.
 */
export function decideRelease(
  baseVersion: string,
  rootVersion: string,
  versionSuffix: string,
  releaseType: ReleaseType,
): ReleasePlan {
  if (baseVersion !== rootVersion) {
    throw new Error(
      `Version mismatch: packages/cli/package.json is ${baseVersion} but root package.json is ${rootVersion}. ` +
        `Set both to the same base version and commit before releasing.`,
    );
  }

  const version = `${baseVersion}${versionSuffix}`;
  const match = SEMVER.exec(version);
  if (match?.groups === undefined) {
    throw new Error(
      `Composed version "${version}" (base "${baseVersion}" + suffix "${versionSuffix}") is not valid SemVer 2.0.0. ` +
        `Fix the base version or the version_suffix input.`,
    );
  }

  const major = match.groups.major;
  const prerelease = match.groups.prerelease;
  const isPrerelease = prerelease !== undefined;

  if (releaseType === "release" && isPrerelease) {
    throw new Error(
      `release_type=release requires a plain version, but the composed version is "${version}". ` +
        `A stable release must not carry a prerelease suffix - clear version_suffix, or use release_type=prerelease.`,
    );
  }
  if (releaseType === "prerelease" && !isPrerelease) {
    throw new Error(
      `release_type=prerelease requires a prerelease suffix, but the composed version is "${version}". ` +
        `Set version_suffix (e.g. "-rc.1"), or use release_type=release.`,
    );
  }

  const npmTag = isPrerelease ? prereleaseDistTag(prerelease) : "latest";
  const isDraft = releaseType === "draft";

  return {
    version,
    releaseType,
    isPrerelease,
    publishNpm: !isDraft,
    npmTag,
    gitTag: `v${version}`,
    pushGitTag: !isDraft,
    majorTag: `v${major}`,
    // Only a stable, live release moves the floating major tag.
    moveMajorTag: releaseType === "release",
    githubReleaseDraft: isDraft,
    githubReleasePrerelease: isPrerelease,
  };
}
