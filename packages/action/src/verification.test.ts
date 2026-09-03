import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
      issueNumber: 7,
      verify: {
        checks: [
          { name: "good tests", run: "npm test" },
          { name: "bad tests", run: "npm run e2e" },
        ],
      },
    });
    expect(outcomes).toEqual([
      { name: "good tests", status: "passed", detail: undefined },
      { name: "bad tests", status: "failed", detail: undefined },
    ]);
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
      issueNumber: 7,
      verify: { checks: [{ name: "t", run: "true" }] },
    });
    expect(engine.runs[0]?.env).toBeUndefined();
  });

  it("web: exit 3 records unavailable, exit 0 passes, exit 2 fails", async () => {
    const evidenceDir = tempDir();
    let exitCode = 3;
    const engine = new FakeEngine(() => ({
      code: exitCode,
      stdout: "",
      stderr: "",
      timedOut: false,
    }));
    const verify = {
      web: [{ name: "app", start: "npm run dev", url: "http://localhost:5173/" }],
    };
    const shared = { engine, log: silentLog, image: "img", workspaceDir: "/ws", issueNumber: 7 };

    expect((await runVerification({ ...shared, evidenceDir, verify }))[0]).toEqual({
      name: "app",
      status: "unavailable",
      detail: "playwright not in image",
    });

    exitCode = 0;
    expect((await runVerification({ ...shared, evidenceDir, verify }))[0]?.status).toBe("passed");

    exitCode = 2;
    expect((await runVerification({ ...shared, evidenceDir, verify }))[0]).toEqual({
      name: "app",
      status: "failed",
      detail: "console errors; see evidence",
    });
  });

  it("web: mounts the verify script read-only and an evidence dir, quotes the url", async () => {
    const evidenceDir = tempDir();
    const engine = new FakeEngine();
    await runVerification({
      engine,
      log: silentLog,
      image: "img",
      workspaceDir: "/ws",
      evidenceDir,
      issueNumber: 7,
      verify: {
        web: [{ name: "app", start: "npm run dev", url: "http://localhost:5173/?slug=x&y=z" }],
      },
    });
    const spec = engine.runs[0];
    expect(spec?.extraMounts).toEqual([
      {
        host: join(evidenceDir, "verify-web.mjs"),
        container: "/fixowl/verify-web.mjs",
        readOnly: true,
      },
      { host: join(evidenceDir, "web-app"), container: "/fixowl/evidence" },
    ]);
    expect(existsSync(join(evidenceDir, "verify-web.mjs"))).toBe(true);
    const command = spec?.argv[2] ?? "";
    expect(command).toContain("( npm run dev )");
    expect(command).toContain("'http://localhost:5173/?slug=x&y=z'");
    expect(command).toContain("--deadline 120");
  });
});
