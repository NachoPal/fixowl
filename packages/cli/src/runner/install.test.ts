import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandHome,
  isUnderHome,
  runnerDirFor,
  runnerPlatform,
  runnerTarballUrl,
  RUNNER_VERSION,
} from "./install.ts";

describe("runnerPlatform", () => {
  it("maps host platforms to runner tarball platforms", () => {
    expect(runnerPlatform("darwin", "x64")).toBe("osx-x64");
    expect(runnerPlatform("darwin", "arm64")).toBe("osx-arm64");
    expect(runnerPlatform("linux", "x64")).toBe("linux-x64");
    expect(() => runnerPlatform("win32", "x64")).toThrow(/unsupported/);
  });
});

describe("runnerTarballUrl", () => {
  it("pins the release version", () => {
    expect(runnerTarballUrl("osx-x64")).toBe(
      `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-x64-${RUNNER_VERSION}.tar.gz`,
    );
  });
});

describe("runner directories", () => {
  it("one install per repo, slash flattened", () => {
    expect(runnerDirFor("~/.fixowl/runners", "NachoPal/storyengine")).toBe(
      join(homedir(), ".fixowl", "runners", "NachoPal__storyengine"),
    );
  });

  it("expands ~ and detects home placement", () => {
    expect(expandHome("~/.fixowl")).toBe(join(homedir(), ".fixowl"));
    expect(isUnderHome("~/.fixowl/runners")).toBe(true);
    expect(isUnderHome("/opt/runners")).toBe(false);
  });
});
