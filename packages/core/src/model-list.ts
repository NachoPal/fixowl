/**
 * Live, provider-served model lists, per-agent and out-of-band on the host (the
 * CLI, at `fixowl validate` time - never inside a container). This lets validate
 * catch a bogus or deprecated model id before the night run instead of at 2am:
 * the hardcoded catalog in `agent-catalog.ts` says which ids fixowl knows about,
 * but only the provider knows which ids an account can actually reach.
 *
 * The abstraction mirrors `agent-usage.ts`: it is agent-aware in the spirit of
 * `getUsageReader(agentName)`. Only agents whose provider exposes a queryable
 * model list have a source (codex/OpenAI first); claude has none and
 * so keeps relying on the hardcoded catalog alone. Adding another agent's source
 * needs no caller change.
 *
 * Pure/deps split follows fixowl convention: the URL shape and response parsing
 * are pure here; the network call is the injected `ModelListProbe.fetchJson`
 * (wired to `fetch` at the CLI edge, faked in tests).
 *
 * Fail-open by contract: an unreachable live list (offline, transport error,
 * non-2xx, missing/rejected key) is NOT a validation failure - it yields
 * `ids: undefined` with a `skippedReason`, and the caller falls back to the
 * catalog with a warning. Only a live list that is definitely fetched AND
 * definitely missing the configured model is a hard failure.
 */

/**
 * How the host reaches one agent's provider model list. `fetchJson` is the
 * single injected I/O edge; it must reject on a non-2xx or transport error.
 * `env` is a lookup map (the resolved secrets/host env) from which the source
 * picks whatever credential it needs.
 */
export interface ModelListProbe {
  env: Record<string, string | undefined>;
  fetchJson(url: string, headers: Record<string, string>): Promise<unknown>;
}

/**
 * Result of a live model-list lookup. `ids` is the served id list on success,
 * or `undefined` when the list could not be observed (missing credential,
 * transport error, non-2xx, unparseable shape) - in which case `skippedReason`
 * says why so the caller can warn and fall back to the catalog.
 */
export interface ModelListResult {
  ids: string[] | undefined;
  skippedReason?: string;
}

/** A per-agent provider model-list source. */
export interface ModelListSource {
  /** Human-readable origin, for logging (e.g. "OpenAI /v1/models"). */
  label: string;
  /** Env var whose value authorizes the read (e.g. "OPENAI_API_KEY"). */
  tokenEnv: string;
  list(probe: ModelListProbe): Promise<ModelListResult>;
}

/** OpenAI's free model-listing endpoint (no inference, no spend). */
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** The env var codex/OpenAI authenticates with. */
const OPENAI_TOKEN_ENV = "OPENAI_API_KEY";

/**
 * Parse the OpenAI `/v1/models` response to its `data[].id` list. Defensive by
 * design so a provider-side shape change is contained here, never in validate:
 * returns `undefined` when the payload is not an object with a `data` array, and
 * silently skips any array entry lacking a non-empty string `id`.
 */
export function parseOpenAiModels(raw: unknown): string[] | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const data = (raw as Record<string, unknown>).data;
  if (!Array.isArray(data)) return undefined;
  const ids: string[] = [];
  for (const item of data) {
    if (item !== null && typeof item === "object") {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

const openAiModelListSource: ModelListSource = {
  label: "OpenAI /v1/models",
  tokenEnv: OPENAI_TOKEN_ENV,
  async list(probe: ModelListProbe): Promise<ModelListResult> {
    const token = probe.env[OPENAI_TOKEN_ENV];
    if (token === undefined || token === "") {
      return {
        ids: undefined,
        skippedReason: `no ${OPENAI_TOKEN_ENV} available to query the OpenAI model list`,
      };
    }
    try {
      const raw = await probe.fetchJson(OPENAI_MODELS_URL, {
        Authorization: `Bearer ${token}`,
      });
      const ids = parseOpenAiModels(raw);
      if (ids === undefined) {
        return { ids: undefined, skippedReason: "OpenAI /v1/models returned an unexpected shape" };
      }
      return { ids };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ids: undefined, skippedReason: `could not reach OpenAI /v1/models (${detail})` };
    }
  },
};

/** Keyed by agent adapter name. Only agents with a queryable model list appear. */
const MODEL_LIST_SOURCES: Record<string, ModelListSource> = { codex: openAiModelListSource };

/**
 * The live model-list source for `agentName`, or `undefined` when the agent has
 * no queryable provider list (claude/script). A caller that gets
 * `undefined` simply keeps relying on the hardcoded catalog.
 */
export function getModelListSource(agentName: string): ModelListSource | undefined {
  return MODEL_LIST_SOURCES[agentName];
}

/** Categorized messages from checking chosen models against a live list. */
export interface LiveModelCheckOutcome {
  /** Models provably absent from a fetched live list; these fail validate. */
  errors: string[];
  /** The live list was unreachable; warn and fall back to the catalog. */
  warnings: string[];
  /** The live list was fetched and every chosen model is present. */
  info: string[];
}

/**
 * Check the chosen model ids against a live-list `result` from `source`. Pure:
 * the caller does the fetch (via `source.list`) and the I/O, this only decides
 * messages. Fail-open contract:
 * - `result.ids === undefined` (unreachable): one warning, no error - the caller
 *   falls back to the hardcoded catalog it already validated against.
 * - `result.ids` present: each model absent from the list is a hard error;
 *   if all are present, one confirming info line.
 *
 * `models` should be the deduped, `undefined`-free set of ids configured for the
 * repo (its default plus each selector-label model). An empty `models` yields no
 * messages (nothing was chosen, so the agent CLI default is used).
 */
export function liveModelCheck(
  source: ModelListSource,
  result: ModelListResult,
  models: string[],
): LiveModelCheckOutcome {
  const outcome: LiveModelCheckOutcome = { errors: [], warnings: [], info: [] };
  if (models.length === 0) return outcome;

  if (result.ids === undefined) {
    outcome.warnings.push(
      `live model check skipped: ${result.skippedReason ?? "the provider model list was unreachable"}; ` +
        "relying on the built-in catalog",
    );
    return outcome;
  }

  const served = new Set(result.ids);
  const missing = models.filter((model) => !served.has(model));
  if (missing.length > 0) {
    for (const model of missing) {
      outcome.errors.push(
        `your ${source.tokenEnv} cannot reach model "${model}" ` +
          `(absent from the live ${source.label} list of ${result.ids.length} models); ` +
          "it may be deprecated, renamed, or misspelled",
      );
    }
    return outcome;
  }

  outcome.info.push(
    `models verified against the live ${source.label} list ` +
      `(${models.join(", ")}; ${result.ids.length} models served)`,
  );
  return outcome;
}
