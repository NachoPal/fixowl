/**
 * Release channel logic: the one piece of real decision-making in the release
 * workflow, kept pure and unit-tested here rather than embedded in fragile YAML.
 *
 * The version committed in the code is the source of truth. The workflow never
 * bumps it. The channel (stable vs prerelease) is derived from the version
 * string itself: a semver prerelease suffix (e.g. `0.2.0-rc.1`) publishes to the
 * npm `rc` dist-tag and produces a prerelease GitHub Release, leaving the `latest`
 * dist-tag and the floating `v<major>` tag untouched; a plain version (e.g.
 * `0.2.0`) publishes to `latest`, cuts a full Release, and force-moves `v<major>`.
 */

/** Strict SemVer 2.0.0 pattern (from semver.org), capturing major and prerelease. */
const SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?<buildmetadata>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export interface ReleasePlan {
  /** The exact version being shipped, taken verbatim from the code. */
  version: string;
  /** True when the version carries a semver prerelease suffix. */
  isPrerelease: boolean;
  /**
   * npm dist-tag to publish under. Always passed to `npm publish --tag`: `rc`
   * for a prerelease, `latest` for a stable release. Passing `latest`
   * explicitly is identical to npm's default and keeps the command uniform.
   */
  npmTag: "latest" | "rc";
  /** Immutable per-version git tag, always created. */
  gitTag: string;
  /** Floating major-line tag (e.g. `v0`) for `uses: NachoPal/fixowl@v0`. */
  majorTag: string;
  /** Whether to force-move `majorTag` to this commit (stable only). */
  moveMajorTag: boolean;
  /** Whether the GitHub Release is marked as a prerelease. */
  githubReleasePrerelease: boolean;
}

/**
 * Derive the full release plan from the two committed versions, verifying they
 * are in lockstep. Throws with an actionable message on mismatch or on a version
 * that is not valid semver - the workflow relies on this to fail loudly.
 */
export function decideRelease(cliVersion: string, rootVersion: string): ReleasePlan {
  if (cliVersion !== rootVersion) {
    throw new Error(
      `Version mismatch: packages/cli/package.json is ${cliVersion} but root package.json is ${rootVersion}. ` +
        `Set both to the same version and commit before releasing.`,
    );
  }

  const match = SEMVER.exec(cliVersion);
  if (match?.groups === undefined) {
    throw new Error(`Not a valid semver version: ${cliVersion}`);
  }

  const major = match.groups.major;
  const isPrerelease = match.groups.prerelease !== undefined;

  return {
    version: cliVersion,
    isPrerelease,
    npmTag: isPrerelease ? "rc" : "latest",
    gitTag: `v${cliVersion}`,
    majorTag: `v${major}`,
    moveMajorTag: !isPrerelease,
    githubReleasePrerelease: isPrerelease,
  };
}
