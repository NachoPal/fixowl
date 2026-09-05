import { describe, expect, it } from "vitest";
import { maskSecret, secretConfirmation, selectionSummary } from "./prompt.ts";

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

describe("selectionSummary", () => {
  it("recaps what a selector block left behind, on one line", () => {
    expect(selectionSummary("  Default model", ["opus"])).toBe("  Default model: opus\n");
    expect(selectionSummary("  Labels", ["heavy", "quick"])).toBe("  Labels: heavy, quick\n");
  });

  it("says so when nothing was selected", () => {
    expect(selectionSummary("  Labels", [])).toBe("  Labels: (none)\n");
  });
});
