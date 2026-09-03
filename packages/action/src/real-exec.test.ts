import { describe, expect, it } from "vitest";
import { realExec } from "./real-exec.ts";

describe("realExec", () => {
  it("pipes stdin to the child and captures stdout", async () => {
    const result = await realExec.run(["cat"], { stdin: "hello owl" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello owl");
  });

  it("survives a child that exits before reading a large stdin (EPIPE)", async () => {
    // Regression: an unhandled stdin EPIPE was an uncaughtException that
    // killed the whole night run instead of failing one issue.
    const result = await realExec.run(["false"], { stdin: "x".repeat(1 << 20) });
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("merges extra env over the parent env", async () => {
    const result = await realExec.run(["printenv", "FIXOWL_TEST_VAR"], {
      env: { FIXOWL_TEST_VAR: "v" },
    });
    expect(result.stdout.trim()).toBe("v");
  });
});
