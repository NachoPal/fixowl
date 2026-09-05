/**
 * Hardcoded catalog of the models and reasoning-effort levels each coding agent
 * accepts. There is no reliable API to query a CLI agent's model/effort list, so
 * this is the single source of truth: `fixowl init` presents it, `fixowl
 * validate` and the config schema reject anything not in it, and the agent
 * adapters pass the chosen values to the CLI. Extend an agent by adding entries.
 */

export interface CatalogModel {
  /** The value passed to the agent CLI's `--model` flag. */
  id: string;
  /** One-line note shown to the operator during `fixowl init`. */
  description: string;
}

export interface AgentCatalogEntry {
  models: readonly CatalogModel[];
  /**
   * Valid reasoning-effort levels, in ascending order. Empty means the agent's
   * CLI has no effort axis, and configuring an effort for it is rejected.
   */
  efforts: readonly string[];
}

/**
 * Keyed by agent adapter name. Only agents that expose a model/effort choice
 * appear here; the test-only `script` adapter deliberately does not.
 */
export const AGENT_MODEL_CATALOG: Record<string, AgentCatalogEntry> = {
  // Claude Code CLI: `--model` takes an alias for the latest model of a family
  // (or a full id), and `--effort` takes one of these levels. Both are accepted
  // in `-p` (headless) mode.
  claude: {
    models: [
      { id: "opus", description: "Most capable; alias for the latest Opus." },
      { id: "sonnet", description: "Balanced capability and speed; alias for the latest Sonnet." },
      { id: "haiku", description: "Fastest and cheapest; alias for the latest Haiku." },
      { id: "fable", description: "Alias for the latest Fable model." },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  // aider: `--model` takes a model name or one of aider's built-in aliases, and
  // `--reasoning-effort` sets the reasoning budget. The alias set below is a
  // sensible starting point; extend it with any model your API key can reach.
  aider: {
    models: [
      { id: "sonnet", description: "aider alias for the latest Anthropic Sonnet." },
      { id: "opus", description: "aider alias for the latest Anthropic Opus." },
      { id: "haiku", description: "aider alias for the latest Anthropic Haiku." },
    ],
    efforts: ["low", "medium", "high"],
  },
  // codex (`codex exec`): `-m` takes a model id and reasoning effort is set via
  // `-c model_reasoning_effort=<level>`. The real model list is server-provided
  // per account; the ids below are the publicly-known codex family and a safe
  // starting point - extend it with any model your OPENAI_API_KEY can reach.
  // Not every model accepts every effort level; codex rejects an unsupported
  // combination at run time.
  codex: {
    models: [
      { id: "gpt-5-codex", description: "Codex-optimized GPT-5; a good default." },
      { id: "gpt-5.1-codex", description: "Newer codex model." },
      { id: "gpt-5.1-codex-max", description: "Highest-capability codex model." },
    ],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
};

export function agentCatalogEntry(agent: string): AgentCatalogEntry | undefined {
  return AGENT_MODEL_CATALOG[agent];
}

export function agentModelIds(agent: string): string[] {
  return (agentCatalogEntry(agent)?.models ?? []).map((model) => model.id);
}

export function agentEfforts(agent: string): string[] {
  return [...(agentCatalogEntry(agent)?.efforts ?? [])];
}

export interface ModelEffortChoice {
  model?: string;
  effort?: string;
}

/**
 * Validates a chosen model and/or effort against the agent's catalog. Returns
 * one human-readable message per problem (empty when everything is valid, or
 * when nothing was chosen). Agent-aware: the same model id may be valid for one
 * agent and unknown to another.
 */
export function validateModelEffort(agent: string, choice: ModelEffortChoice): string[] {
  const errors: string[] = [];
  const entry = agentCatalogEntry(agent);
  if (entry === undefined) {
    if (choice.model !== undefined || choice.effort !== undefined) {
      errors.push(
        `agent "${agent}" has no model/effort catalog; remove model/effort for repos using it`,
      );
    }
    return errors;
  }
  if (choice.model !== undefined && !entry.models.some((model) => model.id === choice.model)) {
    errors.push(
      `model "${choice.model}" is not available for agent "${agent}" ` +
        `(available: ${agentModelIds(agent).join(", ")})`,
    );
  }
  if (choice.effort !== undefined) {
    if (entry.efforts.length === 0) {
      errors.push(`agent "${agent}" does not support a reasoning effort level; remove effort`);
    } else if (!entry.efforts.includes(choice.effort)) {
      errors.push(
        `effort "${choice.effort}" is not available for agent "${agent}" ` +
          `(available: ${entry.efforts.join(", ")})`,
      );
    }
  }
  return errors;
}
