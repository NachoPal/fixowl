import { describe, expect, it } from "vitest";
import { createProgram } from "./program.ts";

function provisionCommand() {
  const provision = createProgram().commands.find((c) => c.name() === "provision");
  if (!provision) throw new Error("provision command not registered");
  return provision;
}

describe("provision command options", () => {
  it("rejects the removed --pr flag as an unknown option", () => {
    const provision = provisionCommand();
    provision.exitOverride();
    // Silence commander's writeErr so the assertion output stays clean.
    provision.configureOutput({ writeErr: () => {} });

    // Parse only the provision command's argv (no action side effects).
    expect(() => provision.parse(["--pr"], { from: "user" })).toThrow(/unknown option '--pr'/);
  });

  it("still accepts the supported --no-schedule / --no-register flags", () => {
    const provision = provisionCommand();
    // Registering an option under these names would be absent if they were
    // dropped; commander exposes them via the negated boolean parsing.
    const flags = provision.options.map((o) => o.long);
    expect(flags).toContain("--no-schedule");
    expect(flags).toContain("--no-register");
    expect(flags).not.toContain("--pr");
  });
});
