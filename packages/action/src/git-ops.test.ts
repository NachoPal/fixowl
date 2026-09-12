import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXOWL_BOT_EMAIL } from "@fixowl/core";
import { describe, expect, it } from "vitest";
import type { Exec } from "./deps.ts";
import { realExec } from "./real-exec.ts";
import {
  createLaneWorkspaces,
  extractGitDir,
  GitWorkspace,
  hostGitDirFor,
  laneWorkDir,
  resolveLaneCount,
  restoreGitDir,
  teardownLanes,
} from "./git-ops.ts";

function makeWorkspace(): { workspaceDir: string; gitMarker: string } {
  const root = mkdtempSync(join(tmpdir(), "fixowl-gitops-"));
  const workspaceDir = join(root, "workspace");
  mkdirSync(join(workspaceDir, ".git"), { recursive: true });
  const gitMarker = "refs-marker";
  writeFileSync(join(workspaceDir, ".git", gitMarker), "real git dir\n");
  return { workspaceDir, gitMarker };
}

describe("extractGitDir / restoreGitDir", () => {
  it("moves .git to the sibling dir and back", () => {
    const { workspaceDir, gitMarker } = makeWorkspace();
    const gitDir = extractGitDir(workspaceDir);
    expect(gitDir).toBe(hostGitDirFor(workspaceDir));
    expect(existsSync(join(workspaceDir, ".git"))).toBe(false);
    expect(readFileSync(join(gitDir, gitMarker), "utf8")).toContain("real git dir");

    restoreGitDir(workspaceDir, gitDir);
    expect(existsSync(gitDir)).toBe(false);
    expect(readFileSync(join(workspaceDir, ".git", gitMarker), "utf8")).toContain("real git dir");
  });

  it("reuses an already-extracted git dir after a crashed run", () => {
    const { workspaceDir } = makeWorkspace();
    const gitDir = extractGitDir(workspaceDir);
    // Crash: no restore. The next run finds no workspace .git and reuses the sibling.
    expect(extractGitDir(workspaceDir)).toBe(gitDir);
    expect(existsSync(gitDir)).toBe(true);
  });

  it("discards a stale extracted dir when the workspace has a fresh checkout", () => {
    const { workspaceDir, gitMarker } = makeWorkspace();
    const gitDir = hostGitDirFor(workspaceDir);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "stale"), "from a crashed run\n");

    extractGitDir(workspaceDir);
    expect(existsSync(join(gitDir, "stale"))).toBe(false);
    expect(existsSync(join(gitDir, gitMarker))).toBe(true);
  });

  it("throws when the workspace is not a git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "fixowl-gitops-"));
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    expect(() => extractGitDir(workspaceDir)).toThrow(/must be a git checkout/);
  });

  it("restore deletes a planted .git instead of merging into it", () => {
    const { workspaceDir, gitMarker } = makeWorkspace();
    const gitDir = extractGitDir(workspaceDir);
    // Hostile agent plants a .git (hooks, config) in the mounted workspace.
    mkdirSync(join(workspaceDir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(workspaceDir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nevil\n");
    writeFileSync(join(workspaceDir, ".git", "config"), "[core]\n\tfsmonitor = evil\n");

    restoreGitDir(workspaceDir, gitDir);
    expect(existsSync(join(workspaceDir, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(join(workspaceDir, ".git", gitMarker), "utf8")).toContain("real git dir");
  });
});

/**
 * A fake Exec that records the env of every git command and always succeeds, so
 * the token-provider wiring can be inspected without a real git.
 */
function recordingExec(): { exec: Exec; envs: Array<Record<string, string> | undefined> } {
  const envs: Array<Record<string, string> | undefined> = [];
  const exec: Exec = {
    async run(_argv, options) {
      envs.push(options?.env);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
  return { exec, envs };
}

function tokenFromEnv(env: Record<string, string> | undefined): string {
  const header = env?.GIT_CONFIG_VALUE_0 ?? "";
  const basic = header.replace(/^AUTHORIZATION: basic /, "");
  return Buffer.from(basic, "base64")
    .toString("utf8")
    .replace(/^x-access-token:/, "");
}

/** A fake Exec that records the argv of every git command and always succeeds. */
function argvRecordingExec(): { exec: Exec; argvs: string[][] } {
  const argvs: string[][] = [];
  const exec: Exec = {
    async run(argv) {
      argvs.push([...argv]);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
  return { exec, argvs };
}

/** The value passed to `git config <key> <value>`, or undefined if unset. */
function configValue(argvs: string[][], key: string): string | undefined {
  const found = argvs.find((argv) => {
    const i = argv.indexOf("config");
    return i !== -1 && argv[i + 1] === key;
  });
  if (found === undefined) return undefined;
  return found[found.indexOf("config") + 2];
}

describe("GitWorkspace configureIdentity", () => {
  it("authors commits under the resolved App bot identity", async () => {
    const { exec, argvs } = argvRecordingExec();
    const identity = {
      name: "fixowl-app[bot]",
      email: "42+fixowl-app[bot]@users.noreply.github.com",
    };
    const ws = new GitWorkspace(exec, "/ws", "/gitdir", undefined, identity);

    await ws.configureIdentity();

    expect(configValue(argvs, "user.name")).toBe(identity.name);
    expect(configValue(argvs, "user.email")).toBe(identity.email);
    // Unattended runs must never hang on host signing.
    expect(configValue(argvs, "commit.gpgsign")).toBe("false");
    expect(configValue(argvs, "tag.gpgsign")).toBe("false");
  });

  it("falls back to the default legacy identity when none is provided", async () => {
    const { exec, argvs } = argvRecordingExec();
    const ws = new GitWorkspace(exec, "/ws", "/gitdir");

    await ws.configureIdentity();

    expect(configValue(argvs, "user.name")).toBe("fixowl");
    expect(configValue(argvs, "user.email")).toBe(FIXOWL_BOT_EMAIL);
    expect(configValue(argvs, "commit.gpgsign")).toBe("false");
    expect(configValue(argvs, "tag.gpgsign")).toBe("false");
  });
});

describe("GitWorkspace token provider", () => {
  it("consults the token provider before each git command (never captured once)", async () => {
    // The whole point of the provider: a token that expires mid-night (a GitHub
    // App installation token) is re-read per command, so a later push uses a
    // fresh token, not the one captured at construction.
    const { exec, envs } = recordingExec();
    let n = 0;
    const ws = new GitWorkspace(exec, "/ws", "/gitdir", () => `token-${n++}`);

    await ws.push("issue/1-x");
    await ws.push("issue/1-x");

    const pushEnvs = envs.filter((env) => env?.GIT_CONFIG_VALUE_0 !== undefined);
    expect(pushEnvs.length).toBe(2);
    expect(tokenFromEnv(pushEnvs[0])).toBe("token-0");
    expect(tokenFromEnv(pushEnvs[1])).toBe("token-1");
    // The provider was consulted each time, so the injected header differs.
    expect(pushEnvs[0]?.GIT_CONFIG_VALUE_0).not.toBe(pushEnvs[1]?.GIT_CONFIG_VALUE_0);
  });

  it("awaits an async token provider and injects the resolved token", async () => {
    const { exec, envs } = recordingExec();
    const ws = new GitWorkspace(exec, "/ws", "/gitdir", async () => "fresh-installation-token");

    await ws.push("issue/2-y");

    const pushEnv = envs.find((env) => env?.GIT_CONFIG_VALUE_0 !== undefined);
    expect(tokenFromEnv(pushEnv)).toBe("fresh-installation-token");
  });

  it("injects no auth env when no provider is given (local-remote tests)", async () => {
    const { exec, envs } = recordingExec();
    const ws = new GitWorkspace(exec, "/ws", "/gitdir");

    await ws.push("issue/3-z");

    expect(envs.every((env) => env === undefined)).toBe(true);
  });
});

const GB = 1024 ** 3;

describe("resolveLaneCount (issue #36 resource guard)", () => {
  it("stays at 1 lane when max_parallel is 1, regardless of memory or chain count", () => {
    expect(
      resolveLaneCount({ maxParallel: 1, chainCount: 10, totalMemBytes: 64 * GB }),
    ).toMatchObject({ laneCount: 1, clampedByMemory: false });
  });

  it("clamps to the chain count when there are fewer chains than the configured max", () => {
    const result = resolveLaneCount({ maxParallel: 8, chainCount: 2, totalMemBytes: 64 * GB });
    expect(result.laneCount).toBe(2);
    expect(result.clampedByMemory).toBe(false);
  });

  it("clamps to floor(0.8 * totalMem / 6GB) when RAM is the binding constraint", () => {
    // 16 GiB * 0.8 / 6 GiB = 2.13 -> 2 lanes, even though 4 were requested and
    // 4 chains are available.
    const result = resolveLaneCount({ maxParallel: 4, chainCount: 4, totalMemBytes: 16 * GB });
    expect(result.memoryGuard).toBe(2);
    expect(result.laneCount).toBe(2);
    expect(result.clampedByMemory).toBe(true);
  });

  it("never returns fewer than 1 lane even on a tiny host", () => {
    const result = resolveLaneCount({ maxParallel: 4, chainCount: 4, totalMemBytes: 1 * GB });
    expect(result.memoryGuard).toBe(1);
    expect(result.laneCount).toBe(1);
    expect(result.clampedByMemory).toBe(true);
  });

  it("does not report a memory clamp when max_parallel itself is the binding constraint", () => {
    const result = resolveLaneCount({ maxParallel: 2, chainCount: 10, totalMemBytes: 64 * GB });
    expect(result.laneCount).toBe(2);
    expect(result.clampedByMemory).toBe(false);
  });
});

async function git(cwd: string, gitDir: string | undefined, ...argv: string[]): Promise<string> {
  const base = gitDir !== undefined ? ["--git-dir", gitDir] : [];
  const result = await realExec.run(
    [
      "git",
      ...base,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@test",
      "-c",
      "commit.gpgsign=false",
      ...argv,
    ],
    { cwd },
  );
  if (result.code !== 0) throw new Error(`git ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

describe("createLaneWorkspaces / teardownLanes (issue #36)", () => {
  it("creates independent worktree lanes that can check out different branches concurrently", async () => {
    const root = mkdtempSync(join(tmpdir(), "fixowl-lanes-"));
    const mainWorkDir = join(root, "workspace");
    mkdirSync(mainWorkDir, { recursive: true });
    await git(mainWorkDir, undefined, "init", "-b", "main");
    writeFileSync(join(mainWorkDir, "app.txt"), "v1\n");
    await git(mainWorkDir, undefined, "add", "-A");
    await git(mainWorkDir, undefined, "commit", "-m", "seed");

    const mainGitDir = extractGitDir(mainWorkDir);
    try {
      const lanes = await createLaneWorkspaces({
        exec: realExec,
        mainGitDir,
        mainWorkDir,
        laneCount: 2,
      });
      expect(lanes).toHaveLength(2);

      // Each lane has its own working directory, distinct from the main one.
      const lane0Dir = laneWorkDir(mainWorkDir, 0);
      const lane1Dir = laneWorkDir(mainWorkDir, 1);
      expect(existsSync(lane0Dir)).toBe(true);
      expect(existsSync(lane1Dir)).toBe(true);
      expect(lane0Dir).not.toBe(lane1Dir);

      // Lanes check out different branches concurrently with no conflict (the
      // whole point of using worktrees instead of a shared checkout).
      await lanes[0]?.configureIdentity();
      await lanes[1]?.configureIdentity();
      await lanes[0]?.checkoutNewBranch("lane-a", "main");
      await lanes[1]?.checkoutNewBranch("lane-b", "main");
      writeFileSync(join(lane0Dir, "a.txt"), "from lane a\n");
      writeFileSync(join(lane1Dir, "b.txt"), "from lane b\n");
      await lanes[0]?.commitAll("lane a work");
      await lanes[1]?.commitAll("lane b work");

      // Each lane's commit landed only on its own branch, and the main
      // workspace's working tree (and checked-out branch) is untouched.
      const laneABranch = await git(mainWorkDir, mainGitDir, "log", "-1", "--format=%s", "lane-a");
      const laneBBranch = await git(mainWorkDir, mainGitDir, "log", "-1", "--format=%s", "lane-b");
      expect(laneABranch.trim()).toBe("lane a work");
      expect(laneBBranch.trim()).toBe("lane b work");
      expect(existsSync(join(mainWorkDir, "a.txt"))).toBe(false);
      expect(existsSync(join(mainWorkDir, "b.txt"))).toBe(false);

      // The git-dir-never-in-a-container invariant holds per lane too: the
      // worktree `.git` file git leaves behind is dropped just like a planted
      // one on the main workspace, before any container would mount the dir.
      lanes[0]?.dropPlantedGitDir();
      expect(existsSync(join(lane0Dir, ".git"))).toBe(false);

      await teardownLanes({ exec: realExec, mainGitDir, mainWorkDir, laneCount: 2 });
      expect(existsSync(lane0Dir)).toBe(false);
      expect(existsSync(lane1Dir)).toBe(false);
      // `git worktree prune` cleared the dangling administrative metadata too.
      const list = await git(mainWorkDir, mainGitDir, "worktree", "list", "--porcelain");
      expect(list).not.toContain("lane-0");
      expect(list).not.toContain("lane-1");
    } finally {
      restoreGitDir(mainWorkDir, mainGitDir);
    }
  });
});
