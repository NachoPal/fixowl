/**
 * Measuring what an API-credit coding agent has spent, from the agent's OWN
 * captured output. This backs the `total_token_budget` stop condition: a hard
 * cap on the total tokens a night may consume, the API-credit counterpart to the
 * subscription `usage_budget_percent` window (`agent-usage.ts`).
 *
 * The crucial difference from `agent-usage.ts` is WHERE the number comes from.
 * A subscription agent (claude on CLAUDE_CODE_OAUTH_TOKEN) has a rolling usage
 * window the host reads out-of-band from the provider. An API-credit agent
 * (codex on OPENAI_API_KEY, or claude on ANTHROPIC_API_KEY) has no real-time
 * per-key spend endpoint fixowl can poll - OpenAI's Usage/Costs API needs an org
 * Admin key and buckets by day - so spend is instead measured IN-BAND: the agent
 * reports its own token usage in the
 * output fixowl already captures (`ExecResult.stdout`), and the run loop
 * accumulates it across issues. There is no network edge and no credential here;
 * this module is a pure parser.
 *
 * Denomination is TOKENS, not dollars. Tokens are the one quantity every
 * API-credit agent reports directly and identically; a dollar figure would need
 * a per-model price table that drifts on every provider price change and every
 * new model id (codex model ids are server-provided per account). The token
 * breakdown captured here (cached-input, reasoning-output) is deliberately kept
 * so a dollar layer can later price it without re-plumbing the accumulator, but
 * fixowl ships the token cap only.
 *
 * Model-agnostic like `agent-adapters.ts`/`agent-usage.ts`: the run loop asks
 * `getSpendMeter(agentName)` and never names a provider. An agent whose spend is
 * not measurable returns a meter that yields `undefined`, opting that run out of
 * the token condition automatically - adding a new agent's meter needs no
 * run-loop change.
 */

/** One agent run's measured token usage. All counts are whole tokens. */
export interface SpendSample {
  /** Billable total for the cap: `inputTokens + outputTokens`. */
  totalTokens: number;
  /** Prompt tokens (INCLUDES the cached subset). */
  inputTokens: number;
  /** Cached-hit subset of `inputTokens` (billed at a discount); kept for future dollar pricing. */
  cachedInputTokens: number;
  /** Completion tokens (INCLUDES the reasoning subset). */
  outputTokens: number;
  /** Reasoning subset of `outputTokens`; kept for future dollar pricing. */
  reasoningOutputTokens: number;
}

/**
 * Reads one agent run's captured output into a `SpendSample`. Returns `undefined`
 * when spend is not measurable for this agent/run - the run loop then abstains
 * from the token condition (fail-open, exactly like the usage abstain). Never
 * throws for a parse problem: an unexpected shape abstains, it does not crash the
 * night.
 */
export interface SpendMeter {
  parse(stdout: string, stderr: string): SpendSample | undefined;
}

/** The zero sample; the identity for `addSamples`. */
export const EMPTY_SPEND: SpendSample = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Sums two samples field-by-field (used to accumulate across attempts/issues). */
export function addSamples(a: SpendSample, b: SpendSample): SpendSample {
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

/** A finite non-negative number read from `record[key]`, else 0. */
function readNum(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Sum the token usage codex reports on its JSONL event stream. `codex exec
 * --json` makes stdout a JSON Lines stream; each `turn.completed` event carries a
 * `usage` object with `input_tokens`, `cached_input_tokens`, `output_tokens`,
 * and `reasoning_output_tokens` (confirmed against codex-cli 0.153.4 and OpenAI's
 * non-interactive docs). `cached_input_tokens` is a subset of `input_tokens` and
 * `reasoning_output_tokens` a subset of `output_tokens`, so the billable total is
 * `input_tokens + output_tokens` (the subsets are carried, not re-added).
 *
 * Per-turn events are SUMMED across the stream: an `exec` run is normally a single
 * turn, but summing is correct if it is ever multi-turn and harmless when it is
 * not. Defensive by design: non-JSON lines (a banner) and events without a usage
 * object are skipped; if no usage is found at all, returns `undefined` (abstain).
 *
 * OPEN VERIFICATION (Open risk 1): this parser was built to the documented
 * schema; a real `codex exec --json` transcript was not captured (no login / no
 * OPENAI_API_KEY / no local OSS model, and a live run is a paid call). A ship
 * should capture one real transcript and confirm the exact envelope - in
 * particular whether `usage` sits directly on the `turn.completed` object (as
 * assumed here) - and whether one exec emits one or many `turn.completed` events.
 * The fixture in `agent-spend.test.ts` is built from the documented shape.
 */
export function parseCodexUsage(stdout: string): SpendSample | undefined {
  let acc = EMPTY_SPEND;
  let found = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // a non-JSON line (e.g. a preamble) is not an event
    }
    if (event === null || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "turn.completed") continue;
    const usage = record.usage;
    if (usage === null || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    const inputTokens = readNum(u, "input_tokens");
    const cachedInputTokens = readNum(u, "cached_input_tokens");
    const outputTokens = readNum(u, "output_tokens");
    const reasoningOutputTokens = readNum(u, "reasoning_output_tokens");
    // A usage object with no recognizable token field is not a measurement.
    if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) continue;
    found = true;
    acc = addSamples(acc, {
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    });
  }
  return found ? acc : undefined;
}

/**
 * Sum the token usage Claude Code reports when run headless as
 * `claude -p --output-format json` (the fix-mode adapter argv sets this). That
 * mode prints a SINGLE JSON result object whose `usage` field carries the
 * Messages-API token breakdown: `input_tokens`, `cache_creation_input_tokens`,
 * `cache_read_input_tokens`, and `output_tokens`. Unlike codex's `usage`
 * (where cached is a subset of `input_tokens`), Claude Code reports the
 * non-cached prompt tokens in `input_tokens` and the cached halves separately,
 * so the billable input is the SUM of all three; `cache_read_input_tokens` is
 * carried as the cached subset for a future dollar layer, and Claude Code does
 * not break out reasoning tokens (kept 0). The billable total is
 * `input + output`.
 *
 * Defensive by design: the object is located by scanning for the first line
 * that parses to a JSON object carrying a usage object (tolerating a leading
 * banner, and `--output-format stream-json`'s trailing result line if that is
 * ever used); a shape with no recognizable token field, or no JSON at all,
 * returns `undefined` (abstain), so a format change fails open to count /
 * wall-clock rather than crashing the night.
 *
 * OPEN VERIFICATION: this parser was built to Claude Code's documented
 * `--output-format json` result shape and the Messages-API `usage` field names;
 * a real `claude -p --output-format json` transcript was not captured in this
 * change (a live run is a paid call). Confirm the exact `usage` envelope against
 * a real run before relying on the claude token cap - in particular that the
 * token counts sit on a top-level `usage` object with these field names. Until
 * then the abstain-on-unexpected-shape keeps it fail-open. (Follow-up: capture
 * one real transcript, alongside the codex Open-risk-1 verification.)
 */
export function parseClaudeCodeUsage(stdout: string): SpendSample | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // a non-JSON line (e.g. a preamble) is not the result object
    }
    if (event === null || typeof event !== "object") continue;
    const usage = (event as Record<string, unknown>).usage;
    if (usage === null || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    const promptTokens = readNum(u, "input_tokens");
    const cacheCreationTokens = readNum(u, "cache_creation_input_tokens");
    const cacheReadTokens = readNum(u, "cache_read_input_tokens");
    const outputTokens = readNum(u, "output_tokens");
    const inputTokens = promptTokens + cacheCreationTokens + cacheReadTokens;
    // A usage object with no recognizable token field is not a measurement.
    if (inputTokens === 0 && outputTokens === 0) continue;
    return {
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      cachedInputTokens: cacheReadTokens,
      outputTokens,
      reasoningOutputTokens: 0,
    };
  }
  return undefined;
}

const codexMeter: SpendMeter = { parse: (stdout) => parseCodexUsage(stdout) };
const claudeMeter: SpendMeter = { parse: (stdout) => parseClaudeCodeUsage(stdout) };

/** A meter for agents whose spend is not measurable in-band; always abstains. */
const noSpendMeter: SpendMeter = { parse: () => undefined };

/**
 * `claude` is metered too, so the `total_token_budget` cap enforces for a
 * claude-on-ANTHROPIC_API_KEY (api-credit) run. It is harmless for a
 * claude-on-subscription run: that config offers no `total_token_budget`, so the
 * parsed sample is accumulated but never trips a cap, and the usage-% window
 * bounds it instead.
 */
const SPEND_METERS: Record<string, SpendMeter> = { codex: codexMeter, claude: claudeMeter };

/**
 * The spend meter for `agentName`. Unknown agents and the zero-spend `script`
 * get `noSpendMeter`, so the token condition simply opts out for them - the run
 * stays bounded by count, the subscription usage window, and wall-clock.
 */
export function getSpendMeter(agentName: string): SpendMeter {
  return SPEND_METERS[agentName] ?? noSpendMeter;
}
