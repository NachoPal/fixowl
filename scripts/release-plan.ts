/**
 * Runtime entry the release workflow calls (`node scripts/release-plan.ts`).
 * Reads the committed base versions and the trigger-time inputs (VERSION_SUFFIX,
 * RELEASE_TYPE), derives the release plan via the pure, unit-tested
 * `decideRelease`, and emits the decision as GitHub Actions step outputs so later
 * steps stay declarative. Exits non-zero with a clear message on a version
 * mismatch, an invalid composed version, or a release/prerelease consistency
 * violation, halting the run before anything is published.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideRelease, type ReleaseType } from "./release-channel.ts";

function versionOf(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`${path} has no string "version" field`);
  }
  return parsed.version;
}

function releaseTypeFrom(raw: string | undefined): ReleaseType {
  if (raw === "release" || raw === "prerelease" || raw === "draft") {
    return raw;
  }
  throw new Error(
    `RELEASE_TYPE must be one of release, prerelease, draft (got ${JSON.stringify(raw)}).`,
  );
}

export function run(): void {
  const baseVersion = versionOf("packages/cli/package.json");
  const rootVersion = versionOf("package.json");
  const versionSuffix = process.env.VERSION_SUFFIX ?? "";
  const releaseType = releaseTypeFrom(process.env.RELEASE_TYPE);

  const plan = decideRelease(baseVersion, rootVersion, versionSuffix, releaseType);

  const outputs: Record<string, string> = {
    version: plan.version,
    release_type: plan.releaseType,
    git_tag: plan.gitTag,
    major_tag: plan.majorTag,
    npm_tag: plan.npmTag,
    is_prerelease: String(plan.isPrerelease),
    publish_npm: String(plan.publishNpm),
    push_git_tag: String(plan.pushGitTag),
    move_major: String(plan.moveMajorTag),
    github_draft: String(plan.githubReleaseDraft),
    github_prerelease: String(plan.githubReleasePrerelease),
  };

  const summary =
    `Release plan for ${plan.version} (release_type=${plan.releaseType}): ` +
    `publish npm=${plan.publishNpm} (dist-tag=${plan.npmTag}), ` +
    `git tag=${plan.gitTag} (push=${plan.pushGitTag}), ` +
    `move ${plan.majorTag}=${plan.moveMajorTag}, ` +
    `Release draft=${plan.githubReleaseDraft} prerelease=${plan.githubReleasePrerelease}`;
  console.log(summary);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput !== undefined && githubOutput !== "") {
    const lines = Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    appendFileSync(githubOutput, `${lines}\n`);
  }
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
