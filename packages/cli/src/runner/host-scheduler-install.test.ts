import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliExecResult } from "../exec.ts";
import { hostSchedulerPlistPath, installHostSchedulerAgent } from "./host-scheduler-launchd.ts";

const run = vi.hoisted(() => vi.fn());
vi.mock("../exec.ts", () => ({ run }));

function withTempHome(): void {
  process.env.HOME = mkdtempSync(join(tmpdir(), "fixowl-install-home-"));
}

function ok(): CliExecResult {
  return { code: 0, stdout: "", stderr: "" };
}

function fail(stderr: string): CliExecResult {
  return { code: 37, stdout: "", stderr };
}

/**
 * `launchctl bootout` returns before launchd finishes tearing the old service
 * down, so an immediate `bootstrap` of the same label can lose the race. The
 * install retries it rather than leaving the host with no armed agent.
 */
describe("installHostSchedulerAgent (bootout/bootstrap race, issue #90)", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = realHome;
    vi.clearAllMocks();
  });

  it("writes the plist and bootstraps after booting the old agent out", async () => {
    withTempHome();
    run.mockResolvedValue(ok());

    await installHostSchedulerAgent({ label: "com.fixowl.test", plist: "<plist/>" });

    expect(readFileSync(hostSchedulerPlistPath("com.fixowl.test"), "utf8")).toBe("<plist/>");
    expect(run.mock.calls.map((call) => call[0][1])).toEqual(["bootout", "bootstrap"]);
  });

  it("retries a bootstrap that lost the race to the bootout", async () => {
    withTempHome();
    const sleep = vi.fn(async () => {});
    run
      .mockResolvedValueOnce(ok()) // bootout
      .mockResolvedValueOnce(fail("Bootstrap failed: 37: Operation already in progress"))
      .mockResolvedValueOnce(ok()); // the retried bootstrap

    await installHostSchedulerAgent({ label: "com.fixowl.test", plist: "<plist/>", sleep });

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("throws with the last failure once the retries are spent", async () => {
    withTempHome();
    run.mockResolvedValue(fail("Bootstrap failed: 5: Input/output error"));

    await expect(
      installHostSchedulerAgent({
        label: "com.fixowl.test",
        plist: "<plist/>",
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Input\/output error/);
    // bootout + three bootstrap attempts.
    expect(run).toHaveBeenCalledTimes(4);
  });
});
