import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runVerification } from "./verification.ts";
import { fail, FakeEngine, ok, silentLog } from "./test-helpers.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fixowl-verify-"));
}

describe("runVerification", () => {
  it("returns no outcomes when nothing is configured (degrade gracefully)", async () => {
    const engine = new FakeEngine();
    const outcomes = await runVerification({
      engine,
      log: silentLog,
      image: "img",
      workspaceDir: "/ws",
      evidenceDir: tempDir(),
      repoFullName: "test/repo",
      issueNumber: 1,
      verify: undefined,
    });
    expect(outcomes).toEqual([]);
    expect(engine.runs).toHaveLength(0);
  });

  it("maps check exit codes to pass/fail and writes evidence logs", async () => {
    const evidenceDir = tempDir();
    const engine = new FakeEngine((spec) =>
      spec.name.includes("bad") ? fail(2, "assertion failed") : ok("all good"),
    );
    const outcomes = await runVerification({
      engine,
      log: silentLog,
      image: "img",
      workspaceDir: "/ws",
      evidenceDir,
      repoFullName: "test/repo",
      issueNumber: 7,
      verify: {
        checks: [
          { name: "good tests", run: "npm test" },
          { name: "bad tests", run: "npm run e2e" },
        ],
      },
    });
    expect(outcomes).toMatchObject([
      { name: "good tests", status: "passed", detail: undefined },
      { name: "bad tests", status: "failed", detail: undefined },
    ]);
    // A passed check carries no fed-back log; a failed one carries its output.
    expect(outcomes[0]?.log).toBeUndefined();
    expect(outcomes[1]?.log).toContain("assertion failed");
    const log = readFileSync(join(evidenceDir, "check-good-tests.log"), "utf8");
    expect(log).toContain("$ npm test");
    expect(log).toContain("all good");
    expect(readFileSync(join(evidenceDir, "check-bad-tests.log"), "utf8")).toContain(
      "assertion failed",
    );
  });

  it("verify containers never receive agent credentials", async () => {
    const engine = new FakeEngine();
    await runVerification({
      engine,
      log: silentLog,
      image: "img",
      workspaceDir: "/ws",
      evidenceDir: tempDir(),
      repoFullName: "test/repo",
      issueNumber: 7,
      verify: { checks: [{ name: "t", run: "true" }] },
    });
    expect(engine.runs[0]?.env).toBeUndefined();
  });
});
