/**
 * Runtime entry the release workflow calls (`node scripts/release-plan.ts`).
 * Reads the two committed versions, derives the release plan via the pure,
 * unit-tested `decideRelease`, and emits the decision as GitHub Actions step
 * outputs so later steps stay declarative. Exits non-zero with a clear message
 * on a version mismatch or an invalid version, halting the run before anything
 * is published.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideRelease } from "./release-channel.ts";

function versionOf(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`${path} has no string "version" field`);
  }
  return parsed.version;
}

export function run(): void {
  const cliVersion = versionOf("packages/cli/package.json");
  const rootVersion = versionOf("package.json");
  const plan = decideRelease(cliVersion, rootVersion);

  const outputs: Record<string, string> = {
    version: plan.version,
    git_tag: plan.gitTag,
    major_tag: plan.majorTag,
    npm_tag: plan.npmTag,
    is_prerelease: String(plan.isPrerelease),
    move_major: String(plan.moveMajorTag),
    github_prerelease: String(plan.githubReleasePrerelease),
  };

  const summary =
    `Release plan for ${plan.version}: ` +
    `channel=${plan.isPrerelease ? "prerelease" : "stable"}, ` +
    `npm dist-tag=${plan.npmTag}, git tag=${plan.gitTag}, ` +
    `move ${plan.majorTag}=${plan.moveMajorTag}, prerelease Release=${plan.githubReleasePrerelease}`;
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
