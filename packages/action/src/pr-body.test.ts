import { describe, expect, it } from "vitest";
import { anyCheckFailed, buildPrBody, buildPrTitle } from "./pr-body.ts";

describe("buildPrTitle", () => {
  it("closes the issue when the commit lands on the default branch", () => {
    expect(buildPrTitle(7, "Fix login")).toBe("fix #7: Fix login");
  });
});

describe("buildPrBody", () => {
  it("renders the verification table and closes line", () => {
    const body = buildPrBody({
      issueNumber: 7,
      verification: [
        { name: "tests", status: "passed" },
        { name: "web", status: "failed", detail: "console errors; see evidence" },
        { name: "e2e", status: "unavailable", detail: "playwright not in image" },
      ],
      runUrl: "https://github.com/o/r/actions/runs/1",
    });
    expect(body).toContain("Closes #7.");
    expect(body).toContain("| tests | ✅ passed |");
    expect(body).toContain("| web | ❌ failed (console errors; see evidence) |");
    expect(body).toContain("| e2e | ⚪ unavailable (playwright not in image) |");
    expect(body).toContain("fixowl-evidence");
    expect(body).toContain("fixowl never merges");
  });

  it("marks stacked PRs prominently", () => {
    const body = buildPrBody({
      issueNumber: 18,
      verification: [],
      stackedOn: { prNumber: 101, branch: "issue/15-parent" },
    });
    expect(body).toContain("Stacked on #101");
    expect(body).toContain("issue/15-parent");
    expect(body).toContain("merge that first");
  });

  it("says so when no verification is configured", () => {
    const body = buildPrBody({ issueNumber: 3, verification: [] });
    expect(body).toContain("No verification is configured");
  });
});

describe("anyCheckFailed", () => {
  it("fails only on failed, not unavailable", () => {
    expect(anyCheckFailed([{ name: "a", status: "unavailable" }])).toBe(false);
    expect(
      anyCheckFailed([
        { name: "a", status: "passed" },
        { name: "b", status: "failed" },
      ]),
    ).toBe(true);
    expect(anyCheckFailed([])).toBe(false);
  });
});
