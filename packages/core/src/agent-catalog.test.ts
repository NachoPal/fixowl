import { describe, expect, it } from "vitest";
import {
  agentCatalogEntry,
  agentEfforts,
  agentModelIds,
  validateModelEffort,
} from "./agent-catalog.ts";

describe("agent catalog", () => {
  it("exposes claude models and the full effort ladder", () => {
    expect(agentModelIds("claude")).toContain("opus");
    expect(agentModelIds("claude")).toContain("sonnet");
    expect(agentEfforts("claude")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("returns undefined for an agent without a catalog", () => {
    expect(agentCatalogEntry("script")).toBeUndefined();
    expect(agentModelIds("script")).toEqual([]);
  });
});

describe("validateModelEffort", () => {
  it("accepts a valid model and effort", () => {
    expect(validateModelEffort("claude", { model: "opus", effort: "max" })).toEqual([]);
  });

  it("accepts an empty choice (nothing selected)", () => {
    expect(validateModelEffort("claude", {})).toEqual([]);
  });

  it("rejects an unknown model with the available list", () => {
    const errors = validateModelEffort("claude", { model: "gpt-5" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/model "gpt-5" is not available for agent "claude"/);
    expect(errors[0]).toMatch(/available: opus, sonnet/);
  });

  it("rejects an unknown effort", () => {
    const errors = validateModelEffort("claude", { effort: "extreme" });
    expect(errors[0]).toMatch(/effort "extreme" is not available for agent "claude"/);
  });

  it("is agent-aware: aider does not accept the claude-only 'max' effort", () => {
    expect(validateModelEffort("aider", { effort: "max" })).toHaveLength(1);
    expect(validateModelEffort("aider", { effort: "high" })).toEqual([]);
  });

  it("rejects model/effort for an agent with no catalog", () => {
    expect(validateModelEffort("script", { model: "opus" })).toHaveLength(1);
    expect(validateModelEffort("script", {})).toEqual([]);
  });
});
