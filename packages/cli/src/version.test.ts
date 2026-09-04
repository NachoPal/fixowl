import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProgram } from "./program.ts";
import { version } from "./version.ts";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("cli version", () => {
  it("is sourced from the CLI's package.json, not a hardcoded literal", () => {
    expect(version).toBe(packageVersion);
    // Guards against a regression to the old `.version("0.1.0")` literal.
    expect(version).not.toBe("0.1.0");
  });

  it("is what the CLI reports via --version", () => {
    // Regression guard for the original bug: the program must report the real
    // package version, so a future hardcoded literal in the command wiring fails.
    expect(createProgram().version()).toBe(packageVersion);
  });
});
