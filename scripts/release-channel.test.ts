import { describe, expect, it } from "vitest";
import { decideRelease } from "./release-channel.ts";

describe("decideRelease", () => {
  it("plain version -> stable, latest tag, moves v<major>", () => {
    const plan = decideRelease("0.2.0", "0.2.0");
    expect(plan).toEqual({
      version: "0.2.0",
      isPrerelease: false,
      npmTag: "latest",
      gitTag: "v0.2.0",
      majorTag: "v0",
      moveMajorTag: true,
      githubReleasePrerelease: false,
    });
  });

  it("uses the real major for the floating tag", () => {
    expect(decideRelease("1.4.7", "1.4.7").majorTag).toBe("v1");
    expect(decideRelease("12.0.0", "12.0.0").majorTag).toBe("v12");
  });

  it("-rc.N version -> rc tag, prerelease Release, no latest/v<major> move", () => {
    const plan = decideRelease("0.2.0-rc.1", "0.2.0-rc.1");
    expect(plan).toEqual({
      version: "0.2.0-rc.1",
      isPrerelease: true,
      npmTag: "rc",
      gitTag: "v0.2.0-rc.1",
      majorTag: "v0",
      moveMajorTag: false,
      githubReleasePrerelease: true,
    });
  });

  it("treats any prerelease suffix as a prerelease (not just rc)", () => {
    for (const v of ["1.0.0-beta", "1.0.0-alpha.2", "1.0.0-0", "1.0.0-next.5"]) {
      const plan = decideRelease(v, v);
      expect(plan.isPrerelease).toBe(true);
      expect(plan.npmTag).toBe("rc");
      expect(plan.moveMajorTag).toBe(false);
    }
  });

  it("build metadata alone is not a prerelease", () => {
    const plan = decideRelease("1.2.3+build.9", "1.2.3+build.9");
    expect(plan.isPrerelease).toBe(false);
    expect(plan.npmTag).toBe("latest");
    expect(plan.moveMajorTag).toBe(true);
  });

  it("fails loudly when cli and root versions diverge", () => {
    expect(() => decideRelease("0.2.0", "0.1.0")).toThrow(/Version mismatch/);
  });

  it("rejects a non-semver version", () => {
    expect(() => decideRelease("v0.2", "v0.2")).toThrow(/valid semver/);
    expect(() => decideRelease("0.2", "0.2")).toThrow(/valid semver/);
    expect(() => decideRelease("latest", "latest")).toThrow(/valid semver/);
  });
});
