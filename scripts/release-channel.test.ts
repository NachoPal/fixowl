import { describe, expect, it } from "vitest";
import { decideRelease } from "./release-channel.ts";

describe("decideRelease", () => {
  it("release + plain version -> latest, moves v<major>, published Release", () => {
    const plan = decideRelease("0.2.0", "", "release");
    expect(plan).toEqual({
      version: "0.2.0",
      releaseType: "release",
      isPrerelease: false,
      publishNpm: true,
      npmTag: "latest",
      gitTag: "v0.2.0",
      pushGitTag: true,
      majorTag: "v0",
      moveMajorTag: true,
      githubReleaseDraft: false,
      githubReleasePrerelease: false,
    });
  });

  it("uses the real major for the floating tag", () => {
    expect(decideRelease("1.4.7", "", "release").majorTag).toBe("v1");
    expect(decideRelease("12.0.0", "", "release").majorTag).toBe("v12");
  });

  it("prerelease + -rc.1 -> @rc, no v<major> move, prerelease Release", () => {
    const plan = decideRelease("0.2.0", "-rc.1", "prerelease");
    expect(plan).toEqual({
      version: "0.2.0-rc.1",
      releaseType: "prerelease",
      isPrerelease: true,
      publishNpm: true,
      npmTag: "rc",
      gitTag: "v0.2.0-rc.1",
      pushGitTag: true,
      majorTag: "v0",
      moveMajorTag: false,
      githubReleaseDraft: false,
      githubReleasePrerelease: true,
    });
  });

  it("prerelease + -beta.2 -> @beta dist-tag from the leading identifier", () => {
    const plan = decideRelease("1.0.0", "-beta.2", "prerelease");
    expect(plan.version).toBe("1.0.0-beta.2");
    expect(plan.npmTag).toBe("beta");
    expect(plan.isPrerelease).toBe(true);
    expect(plan.moveMajorTag).toBe(false);
  });

  it("prerelease dist-tag falls back to rc when the leading identifier is numeric", () => {
    const plan = decideRelease("1.0.0", "-1", "prerelease");
    expect(plan.version).toBe("1.0.0-1");
    expect(plan.npmTag).toBe("rc");
  });

  it("prerelease + empty suffix -> error (a prerelease needs a suffix)", () => {
    expect(() => decideRelease("0.2.0", "", "prerelease")).toThrow(/requires a prerelease suffix/);
  });

  it("release + -rc.1 -> error (a stable release must not carry a suffix)", () => {
    expect(() => decideRelease("0.2.0", "-rc.1", "release")).toThrow(
      /must not carry a prerelease suffix/,
    );
  });

  it("draft -> no npm publish, no tag push, no major move, draft Release", () => {
    const plan = decideRelease("0.2.0", "", "draft");
    expect(plan).toEqual({
      version: "0.2.0",
      releaseType: "draft",
      isPrerelease: false,
      publishNpm: false,
      npmTag: "latest",
      gitTag: "v0.2.0",
      pushGitTag: false,
      majorTag: "v0",
      moveMajorTag: false,
      githubReleaseDraft: true,
      githubReleasePrerelease: false,
    });
  });

  it("draft with a prerelease suffix marks the draft Release as prerelease but still ships nothing", () => {
    const plan = decideRelease("0.2.0", "-rc.1", "draft");
    expect(plan.version).toBe("0.2.0-rc.1");
    expect(plan.publishNpm).toBe(false);
    expect(plan.pushGitTag).toBe(false);
    expect(plan.moveMajorTag).toBe(false);
    expect(plan.githubReleaseDraft).toBe(true);
    expect(plan.githubReleasePrerelease).toBe(true);
  });

  it("rejects a composed version that is not valid semver", () => {
    expect(() => decideRelease("0.2.0", "-rc.1.", "prerelease")).toThrow(/not valid SemVer/);
    expect(() => decideRelease("0.2.0", "..bad", "prerelease")).toThrow(/not valid SemVer/);
    expect(() => decideRelease("0.2", "", "release")).toThrow(/not valid SemVer/);
  });
});
