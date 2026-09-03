import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractGitDir, hostGitDirFor, restoreGitDir } from "./git-ops.ts";

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
