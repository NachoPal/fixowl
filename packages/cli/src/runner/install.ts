import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runOrThrow } from "../exec.ts";

/** Pinned actions/runner release; checksums from its release notes. */
export const RUNNER_VERSION = "2.337.0";

const RUNNER_CHECKSUMS: Record<string, string> = {
  "osx-x64": "d383f505d7ed041b1873ab68c35dd766fc093f2252330f95bb427be8f2c6dcfc",
  "osx-arm64": "5a2cd92908a93d7276a194e1de6008099f3e7946f3f8e14aa7a1a7b4a31fdec2",
  "linux-x64": "70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613",
};

export function runnerPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): "osx-x64" | "osx-arm64" | "linux-x64" {
  if (platform === "darwin") return arch === "arm64" ? "osx-arm64" : "osx-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  throw new Error(`unsupported runner platform: ${platform}/${arch}`);
}

export function runnerTarballUrl(platform: string): string {
  return `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-${platform}-${RUNNER_VERSION}.tar.gz`;
}

/**
 * One runner install per repo, under $HOME so Colima's VM (which shares $HOME)
 * can see workspace paths for volume mounts.
 */
export function runnerDirFor(baseDir: string, repoFullName: string): string {
  return join(expandHome(baseDir), repoFullName.replace("/", "__"));
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function isUnderHome(path: string): boolean {
  return expandHome(path).startsWith(homedir() + "/");
}

export function isRunnerInstalled(dir: string): boolean {
  return existsSync(join(dir, "config.sh"));
}

export function isRunnerConfigured(dir: string): boolean {
  return existsSync(join(dir, ".runner"));
}

export async function ensureRunnerInstalled(dir: string): Promise<"installed" | "already"> {
  if (isRunnerInstalled(dir)) return "already";
  const platform = runnerPlatform();
  const expected = RUNNER_CHECKSUMS[platform];
  if (expected === undefined) throw new Error(`no pinned checksum for ${platform}`);

  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, "actions-runner.tar.gz");
  const response = await fetch(runnerTarballUrl(platform));
  if (!response.ok) {
    throw new Error(`runner download failed: HTTP ${response.status}`);
  }
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));

  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `runner tarball checksum mismatch for ${platform}: expected ${expected}, got ${actual}`,
    );
  }
  await runOrThrow(["tar", "-xzf", tarball, "-C", dir]);
  await runOrThrow(["rm", tarball]);
  return "installed";
}

export async function configureRunner(params: {
  dir: string;
  repoFullName: string;
  registrationToken: string;
  runnerName: string;
}): Promise<"configured" | "already"> {
  if (isRunnerConfigured(params.dir)) return "already";
  await runOrThrow(
    [
      "./config.sh",
      "--unattended",
      "--replace",
      "--url",
      `https://github.com/${params.repoFullName}`,
      "--token",
      params.registrationToken,
      "--name",
      params.runnerName,
      "--labels",
      "fixowl",
      "--work",
      "_work",
    ],
    { cwd: params.dir },
  );
  return "configured";
}

export async function removeRunnerConfig(dir: string, removalToken: string): Promise<void> {
  await runOrThrow(["./config.sh", "remove", "--token", removalToken], { cwd: dir });
}

/**
 * Env for the runner service process. DOCKER_HOST points jobs at the Colima
 * socket; PATH covers Homebrew on both Intel (/usr/local) and Apple Silicon
 * (/opt/homebrew). The runner reads `.env` at service start.
 */
export function writeRunnerEnvFile(dir: string, dockerHost?: string): void {
  const lines = [
    `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...(dockerHost !== undefined ? [`DOCKER_HOST=${dockerHost}`] : []),
  ];
  writeFileSync(join(dir, ".env"), lines.join("\n") + "\n");
}
