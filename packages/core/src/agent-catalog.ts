/**
 * Hardcoded catalog of the models and reasoning-effort levels each coding agent
 * accepts. There is no reliable API to query a CLI agent's model/effort list, so
 * this is the single source of truth: `fixowl init` presents it, `fixowl
 * validate` and the config schema reject anything not in it, and the agent
 * adapters pass the chosen values to the CLI. Extend an agent by adding entries.
 */

import { ANTHROPIC_API_KEY_ENV } from "./agent-adapters.ts";

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

/** How an agent's credential is billed. Drives which run-budget the wizard offers. */
export type BillingModel = "subscription" | "api-credit" | "none";

/**
 * Per-agent DEFAULT billing model, keyed by adapter name. Unlike
 * `AGENT_MODEL_CATALOG` (which lists only agents that expose a model/effort
 * choice), this covers every adapter, `script` included. A `subscription` agent
 * bills against a rolling usage window fixowl can read out-of-band
 * (`agent-usage.ts`), so it is bounded by `usage_budget_percent`; an
 * `api-credit` agent bills per token with no such window, so it is bounded by
 * the in-band `total_token_budget` measured from the agent's own reported token
 * usage (`agent-spend.ts`); `script` spends nothing.
 *
 * `claude` is the name-keyed default of `subscription`, but its billing is not a
 * pure function of the agent name: the same adapter bills as a subscription with
 * an OAuth token and as API usage with an API key. `agentBilling` refines the
 * name default with the resolved env allowlist (the chosen auth mode).
 */
export const AGENT_BILLING: Record<string, BillingModel> = {
  claude: "subscription",
  codex: "api-credit",
  script: "none",
};

/**
 * The billing model for `agent`, refined by its resolved env allowlist (`env`).
 * Billing is auth-aware, not purely name-keyed: the native `claude` adapter runs
 * on a subscription OAuth token (`subscription`) OR a Console API key
 * (`api-credit`), and the credential in `env` decides which. When
 * `ANTHROPIC_API_KEY` is in claude's allowlist it wins (Claude Code uses the API
 * key in headless mode when present; see agent-adapters.ts) and the run bills as
 * metered API usage. `env` omitted (or without the API key) falls back to the
 * name-keyed default, so claude stays `subscription`. An unknown agent defaults
 * to `api-credit`: the safe assumption for a paid CLI, so a newly added paid
 * agent gets the total-token budget offered rather than silently skipped.
 */
export function agentBilling(agent: string, env?: readonly string[]): BillingModel {
  if (agent === "claude" && env !== undefined && env.includes(ANTHROPIC_API_KEY_ENV)) {
    return "api-credit";
  }
  return AGENT_BILLING[agent] ?? "api-credit";
}

export function agentCatalogEntry(agent: string): AgentCatalogEntry | undefined {
  return AGENT_MODEL_CATALOG[agent];
}

/**
 * Whether a raw provider model id belongs to the codex family. OpenAI's
 * `/v1/models` returns the WHOLE account catalog (gpt-4*, embeddings, whisper,
 * tts, dall-e, ...); only the codex-family ids are meaningful to the codex
 * adapter. Every codex model id carries the `codex` token (`gpt-5-codex`,
 * `gpt-5.1-codex`, `gpt-5.1-codex-max`, `codex-mini-latest`, ...), which the
 * non-codex OpenAI ids never do, so a substring match cleanly excludes them.
 * Kept here, next to the catalog, so the live init picker (`model-list.ts`) and
 * any future consumer share one owner for the family shape rather than
 * re-deriving it.
 */
export function isCodexFamilyModel(id: string): boolean {
  return id.includes("codex");
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
