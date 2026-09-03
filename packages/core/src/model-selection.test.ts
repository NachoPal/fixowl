import { describe, expect, it } from "vitest";
import { resolveModelSelection, type LabelModelMap } from "./model-selection.ts";

const labelModels: LabelModelMap = {
  heavy: { model: "opus", effort: "max" },
  quick: { model: "haiku", effort: "low" },
};

describe("resolveModelSelection", () => {
  it("uses the selector label's model/effort when exactly one is present", () => {
    const result = resolveModelSelection({
      issueLabels: ["overnight", "heavy"],
      labelModels,
    });
    expect(result).toEqual({
      ok: true,
      selection: { model: "opus", effort: "max" },
      source: "label",
      label: "heavy",
    });
  });

  it("refuses loudly when two or more selector labels collide", () => {
    const result = resolveModelSelection({
      issueLabels: ["heavy", "quick", "overnight"],
      labelModels,
      default: { model: "sonnet", effort: "medium" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflictingLabels).toEqual(["heavy", "quick"]);
      expect(result.error).toMatch(/2 fixowl model-selector labels \(heavy, quick\)/);
      expect(result.error).toMatch(/refusing to guess/);
    }
  });

  it("falls back to the default when no selector label is present", () => {
    const result = resolveModelSelection({
      issueLabels: ["overnight"],
      labelModels,
      default: { model: "sonnet", effort: "medium" },
    });
    expect(result).toEqual({
      ok: true,
      selection: { model: "sonnet", effort: "medium" },
      source: "default",
    });
  });

  it("honors a partial default (only one field set)", () => {
    const result = resolveModelSelection({
      issueLabels: [],
      labelModels: {},
      default: { effort: "high" },
    });
    expect(result).toEqual({
      ok: true,
      selection: { model: undefined, effort: "high" },
      source: "default",
    });
  });

  it("falls through to the agent CLI default (no flag) when no label and no default", () => {
    const result = resolveModelSelection({ issueLabels: ["overnight"], labelModels: {} });
    expect(result).toEqual({ ok: true, selection: {}, source: "agent-default" });
  });

  it("treats an empty default object as no default", () => {
    const result = resolveModelSelection({
      issueLabels: ["overnight"],
      labelModels: {},
      default: {},
    });
    expect(result.ok && result.source).toBe("agent-default");
  });
});
