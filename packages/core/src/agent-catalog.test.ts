import { describe, expect, it } from "vitest";
import { ANTHROPIC_API_KEY_ENV, CLAUDE_OAUTH_TOKEN_ENV } from "./agent-adapters.ts";
import {
  agentBilling,
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

  it("exposes codex models and its effort ladder", () => {
    expect(agentModelIds("codex")).toContain("gpt-5-codex");
    expect(agentModelIds("codex")).toContain("gpt-5.1-codex-max");
    expect(agentEfforts("codex")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  it("returns undefined for an agent without a catalog", () => {
    expect(agentCatalogEntry("script")).toBeUndefined();
    expect(agentModelIds("script")).toEqual([]);
  });
});

describe("agentBilling", () => {
  it("classifies each agent's billing model from its name default", () => {
    expect(agentBilling("claude")).toBe("subscription");
    expect(agentBilling("codex")).toBe("api-credit");
    expect(agentBilling("script")).toBe("none");
  });

  it("is auth-aware for claude: the API key makes it api-credit, the OAuth token keeps it subscription", () => {
    expect(agentBilling("claude", [ANTHROPIC_API_KEY_ENV])).toBe("api-credit");
    expect(agentBilling("claude", [CLAUDE_OAUTH_TOKEN_ENV])).toBe("subscription");
    // Both present: the API key wins in headless mode, so it bills as API credit.
    expect(agentBilling("claude", [CLAUDE_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV])).toBe(
      "api-credit",
    );
    // env omitted falls back to the name-keyed default (subscription).
    expect(agentBilling("claude")).toBe("subscription");
  });

  it("ignores env for a non-claude agent (billing stays name-keyed)", () => {
    expect(agentBilling("codex", [ANTHROPIC_API_KEY_ENV])).toBe("api-credit");
    expect(agentBilling("script", [ANTHROPIC_API_KEY_ENV])).toBe("none");
  });

  it("defaults an unknown agent to api-credit (the safe assumption for a paid CLI)", () => {
    expect(agentBilling("some-future-agent")).toBe("api-credit");
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

  it("is agent-aware: codex does not accept the claude-only 'max' effort", () => {
    expect(validateModelEffort("codex", { effort: "max" })).toHaveLength(1);
    expect(validateModelEffort("codex", { effort: "high" })).toEqual([]);
  });

  it("validates codex model+effort and rejects unknown combinations", () => {
    expect(validateModelEffort("codex", { model: "gpt-5-codex", effort: "xhigh" })).toEqual([]);
    expect(validateModelEffort("codex", { effort: "minimal" })).toEqual([]);
    const badModel = validateModelEffort("codex", { model: "opus" });
    expect(badModel).toHaveLength(1);
    expect(badModel[0]).toMatch(/model "opus" is not available for agent "codex"/);
    // 'max' is a claude-only effort; codex tops out at xhigh.
    const badEffort = validateModelEffort("codex", { effort: "max" });
    expect(badEffort).toHaveLength(1);
    expect(badEffort[0]).toMatch(/effort "max" is not available for agent "codex"/);
  });

  it("rejects model/effort for an agent with no catalog", () => {
    expect(validateModelEffort("script", { model: "opus" })).toHaveLength(1);
    expect(validateModelEffort("script", {})).toEqual([]);
  });
});
