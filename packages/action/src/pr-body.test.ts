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

  it("shows a green CI section when the required checks passed", () => {
    const body = buildPrBody({ issueNumber: 7, verification: [], ci: { state: "green" } });
    expect(body).toContain("## CI");
    expect(body).toContain("required checks are green");
  });

  it("notes the fallback in the green CI section", () => {
    const body = buildPrBody({
      issueNumber: 7,
      verification: [],
      ci: { state: "green", usedFallback: true },
    });
    expect(body).toContain("gated on all completed checks");
  });

  it("lists the failing required checks when the budget was exhausted red", () => {
    const body = buildPrBody({
      issueNumber: 7,
      verification: [],
      ci: {
        state: "failed",
        reason: "red",
        failures: [
          { name: "build", summary: "dist/ is stale", detailsUrl: "https://github.com/o/r/runs/1" },
        ],
      },
    });
    expect(body).toContain("still red after fixowl's last attempt");
    expect(body).toContain("This PR is a draft.");
    expect(body).toContain("| build | dist/ is stale - [logs](https://github.com/o/r/runs/1) |");
  });

  it("explains a CI timeout exhaustion", () => {
    const body = buildPrBody({
      issueNumber: 7,
      verification: [],
      ci: { state: "failed", reason: "timeout", failures: [] },
    });
    expect(body).toContain("did not complete within fixowl's time budget");
  });

  it("escapes a detailsUrl so it cannot break out of the logs link", () => {
    const body = buildPrBody({
      issueNumber: 7,
      verification: [],
      ci: {
        state: "failed",
        reason: "red",
        failures: [
          { name: "build", summary: "boom", detailsUrl: "https://ci.test/run(1) [x](javascript:1)" },
        ],
      },
    });
    // The raw ')' and '(' must be percent-escaped, so the link target ends at
    // the encoded URL and nothing after it leaks out as markdown.
    expect(body).toContain(
      "[logs](https://ci.test/run%281%29%20%5Bx%5D%28javascript:1%29)",
    );
    expect(body).not.toContain("run(1) [x]");
  });

  it("drops a non-http or malformed detailsUrl rather than rendering it raw", () => {
    const body = buildPrBody({
      issueNumber: 7,
      verification: [],
      ci: {
        state: "failed",
        reason: "red",
        failures: [
          { name: "build", summary: "boom", detailsUrl: "javascript:alert(1)" },
          { name: "lint", summary: "nope", detailsUrl: "not a url" },
        ],
      },
    });
    expect(body).not.toContain("[logs]");
    expect(body).toContain("| build | boom |");
    expect(body).toContain("| lint | nope |");
  });

  it("sanitizes untrusted check names and summaries in the CI table", () => {
    const body = buildPrBody({
      issueNumber: 7,
      verification: [],
      ci: {
        state: "failed",
        reason: "red",
        failures: [{ name: "a | b", summary: "line one\nline two | pipe" }],
      },
    });
    expect(body).toContain("| a \\| b | line one line two \\| pipe |");
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
