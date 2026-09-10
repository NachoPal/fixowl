/**
 * Measuring what an API-credit coding agent has spent, from the agent's OWN
 * captured output. This backs the `total_token_budget` stop condition: a hard
 * cap on the total tokens a night may consume, the API-credit counterpart to the
 * subscription `usage_budget_percent` window (`agent-usage.ts`).
 *
 * The crucial difference from `agent-usage.ts` is WHERE the number comes from.
 * A subscription agent (claude) has a rolling usage window the host reads
 * out-of-band from the provider. An API-credit agent (codex on OPENAI_API_KEY,
 * aider on ANTHROPIC_API_KEY) has no real-time per-key spend endpoint fixowl can
 * poll - OpenAI's Usage/Costs API needs an org Admin key and buckets by day - so
 * spend is instead measured IN-BAND: the agent reports its own token usage in the
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

/** Matches an aider usage line, e.g. `Tokens: 1663k sent, 2.1k received.` */
const AIDER_TOKENS_RE = /Tokens:\s*([\d.]+)\s*([kKmM]?)\s*sent,\s*([\d.]+)\s*([kKmM]?)\s*received/g;

/** Expands aider's `k`/`M` suffix (`1663k` -> 1_663_000) to whole tokens. */
function aiderCount(mantissa: string, suffix: string): number {
  const base = Number(mantissa);
  if (!Number.isFinite(base)) return 0;
  const factor = suffix === "" ? 1 : suffix.toLowerCase() === "k" ? 1_000 : 1_000_000;
  return Math.round(base * factor);
}

/**
 * Sum the token usage aider prints, e.g. `Tokens: 1663k sent, 0 received. Cost:
 * $4.99 message, $9.68 session.` Each exchange prints one line; they are summed
 * for the run total (mirrors the codex per-turn sum). `sent` maps to
 * `inputTokens`, `received` to `outputTokens`; aider does not break out cached /
 * reasoning tokens, so those stay 0. Returns `undefined` when no line is found.
 *
 * OPEN VERIFICATION (Open risk 2): aider was not run (not installed); this format
 * is from aider's docs/issues, not a captured run. Confirm against a real aider
 * transcript before relying on the aider token cap. The abstain-on-no-match keeps
 * a format drift fail-open (falls through to count / wall-clock).
 */
export function parseAiderUsage(stdout: string): SpendSample | undefined {
  let acc = EMPTY_SPEND;
  let found = false;
  for (const match of stdout.matchAll(AIDER_TOKENS_RE)) {
    const inputTokens = aiderCount(match[1] ?? "", match[2] ?? "");
    const outputTokens = aiderCount(match[3] ?? "", match[4] ?? "");
    if (inputTokens === 0 && outputTokens === 0) continue;
    found = true;
    acc = addSamples(acc, {
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      reasoningOutputTokens: 0,
    });
  }
  return found ? acc : undefined;
}

const codexMeter: SpendMeter = { parse: (stdout) => parseCodexUsage(stdout) };
const aiderMeter: SpendMeter = { parse: (stdout) => parseAiderUsage(stdout) };

/** A meter for agents whose spend is not measurable in-band; always abstains. */
const noSpendMeter: SpendMeter = { parse: () => undefined };

const SPEND_METERS: Record<string, SpendMeter> = { codex: codexMeter, aider: aiderMeter };

/**
 * The spend meter for `agentName`. Unknown agents (and subscription agents like
 * `claude`, and the zero-spend `script`) get `noSpendMeter`, so the token
 * condition simply opts out for them - the run stays bounded by count, the
 * subscription usage window, and wall-clock.
 */
export function getSpendMeter(agentName: string): SpendMeter {
  return SPEND_METERS[agentName] ?? noSpendMeter;
}
