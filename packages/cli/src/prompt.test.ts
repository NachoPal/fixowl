import { describe, expect, it } from "vitest";
import {
  isMaskableKeypress,
  maskSecret,
  SECRET_HINT,
  secretConfirmation,
  secretLabel,
  selectionSummary,
} from "./prompt.ts";

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

describe("secretLabel", () => {
  it("appends the press-Enter hint so every masked prompt tells the user what to do", () => {
    expect(secretLabel("App private key", "")).toBe(`App private key ${SECRET_HINT}: `);
    expect(SECRET_HINT).toContain("Enter");
  });

  it("keeps the keep-existing suffix before the hint", () => {
    expect(secretLabel("Admin token", " [keep ghp_…abcd (20 chars)]")).toBe(
      `Admin token [keep ghp_…abcd (20 chars)] ${SECRET_HINT}: `,
    );
  });

  it("never embeds anything that could reveal a secret", () => {
    const label = secretLabel("OpenAI key", "");
    expect(label).not.toContain("sk-");
  });
});

describe("isMaskableKeypress", () => {
  it("counts ordinary printable characters (so a paste shows feedback)", () => {
    for (const ch of ["g", "h", "p", "_", "A", "9", "=", "-", " "]) {
      expect(isMaskableKeypress(ch, { name: ch })).toBe(true);
    }
  });

  it("ignores Enter, Tab, and other control characters", () => {
    expect(isMaskableKeypress("\r", { name: "return" })).toBe(false);
    expect(isMaskableKeypress("\n", { name: "enter" })).toBe(false);
    expect(isMaskableKeypress("\t", { name: "tab" })).toBe(false);
    expect(isMaskableKeypress("", { name: "backspace" })).toBe(false);
  });

  it("ignores control and meta chords", () => {
    expect(isMaskableKeypress("c", { name: "c", ctrl: true })).toBe(false);
    expect(isMaskableKeypress("v", { name: "v", meta: true })).toBe(false);
  });

  it("ignores multi-character escape sequences and undefined keys", () => {
    expect(isMaskableKeypress("[A", { name: "up" })).toBe(false);
    expect(isMaskableKeypress(undefined, { name: "up" })).toBe(false);
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
