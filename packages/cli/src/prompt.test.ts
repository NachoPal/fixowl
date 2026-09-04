import { describe, expect, it } from "vitest";
import { maskSecret, secretConfirmation } from "./prompt.ts";

describe("secretConfirmation", () => {
  it("confirms a captured value with a masked preview, never the raw secret", () => {
    const line = secretConfirmation("ghp_supersecrettoken", false);
    expect(line).toContain("✓ received");
    expect(line).toContain(maskSecret("ghp_supersecrettoken"));
    expect(line).not.toContain("ghp_supersecrettoken");
  });

  it("confirms an empty answer keeps the existing value", () => {
    expect(secretConfirmation("", true)).toBe("✓ kept existing\n");
  });

  it("says nothing for an empty answer with no existing value to keep", () => {
    expect(secretConfirmation("", false)).toBe("");
  });
});
