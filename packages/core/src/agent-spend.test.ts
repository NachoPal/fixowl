import { describe, expect, it } from "vitest";
import { getSpendMeter, parseClaudeCodeUsage, parseCodexUsage } from "./agent-spend.ts";

// A `codex exec --json` transcript built from the DOCUMENTED schema (codex-cli
// 0.153.4 + OpenAI's non-interactive docs): stdout is JSONL; `turn.completed`
// carries a `usage` object. A real transcript should confirm the exact envelope
// (Open risk 1), but the parser is defensive and this fixture pins its contract.
const CODEX_ONE_TURN = [
  `{"type":"thread.started","thread_id":"th_1"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":400,"output_tokens":800,"reasoning_output_tokens":300}}`,
].join("\n");

const CODEX_TWO_TURNS = [
  `{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":500,"reasoning_output_tokens":100}}`,
  `{"type":"item.completed","item":{"type":"agent_message","text":"still going"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":2000,"cached_input_tokens":1000,"output_tokens":300,"reasoning_output_tokens":50}}`,
].join("\n");

describe("parseCodexUsage", () => {
  it("reads one turn.completed usage object", () => {
    expect(parseCodexUsage(CODEX_ONE_TURN)).toEqual({
      totalTokens: 2000, // input_tokens + output_tokens; cached/reasoning are subsets, not re-added
      inputTokens: 1200,
      cachedInputTokens: 400,
      outputTokens: 800,
      reasoningOutputTokens: 300,
    });
  });

  it("sums usage across multiple turn.completed events", () => {
    expect(parseCodexUsage(CODEX_TWO_TURNS)).toEqual({
      totalTokens: 3800, // (1000+500) + (2000+300)
      inputTokens: 3000,
      cachedInputTokens: 1000,
      outputTokens: 800,
      reasoningOutputTokens: 150,
    });
  });

  it("skips non-JSON lines (a banner) and ignores non-usage events", () => {
    const withNoise = `codex starting...\nnot json\n${CODEX_ONE_TURN}\n[done]`;
    expect(parseCodexUsage(withNoise)?.totalTokens).toBe(2000);
  });

  it("abstains (undefined) when no usage is present", () => {
    expect(parseCodexUsage("")).toBeUndefined();
    expect(parseCodexUsage(`{"type":"turn.started"}\nplain text output`)).toBeUndefined();
    // An unexpected shape must abstain, not crash.
    expect(parseCodexUsage(`{"type":"turn.completed"}`)).toBeUndefined();
    expect(parseCodexUsage(`{"type":"turn.completed","usage":"nope"}`)).toBeUndefined();
  });
});

// A `claude -p --output-format json` result object built from the DOCUMENTED
// shape: a single JSON object carrying a `usage` object with the Messages-API
// token fields. `input_tokens` is the NON-cached prompt subset; the cached
// halves are separate, so the billable input is their sum. A real transcript
// should confirm the exact envelope (OPEN VERIFICATION in agent-spend.ts), but
// the parser is defensive and this fixture pins its contract.
const CLAUDE_RESULT_JSON = JSON.stringify({
  type: "result",
  subtype: "success",
  total_cost_usd: 0.05,
  result: "done",
  usage: {
    input_tokens: 500,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 300,
    output_tokens: 800,
  },
});

describe("parseClaudeCodeUsage", () => {
  it("sums the prompt + cache halves into inputTokens and keeps cache_read as the cached subset", () => {
    expect(parseClaudeCodeUsage(CLAUDE_RESULT_JSON)).toEqual({
      totalTokens: 1800, // (500+200+300) + 800
      inputTokens: 1000, // input + cache_creation + cache_read
      cachedInputTokens: 300, // cache_read only
      outputTokens: 800,
      reasoningOutputTokens: 0, // Claude Code does not break these out
    });
  });

  it("locates the result object past a leading banner line", () => {
    const withBanner = `starting claude...\nnot json\n${CLAUDE_RESULT_JSON}`;
    expect(parseClaudeCodeUsage(withBanner)?.totalTokens).toBe(1800);
  });

  it("tolerates only output tokens (input fields absent)", () => {
    expect(parseClaudeCodeUsage(JSON.stringify({ usage: { output_tokens: 42 } }))).toEqual({
      totalTokens: 42,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 42,
      reasoningOutputTokens: 0,
    });
  });

  it("abstains (undefined) on an unexpected or missing usage shape", () => {
    expect(parseClaudeCodeUsage("")).toBeUndefined();
    expect(parseClaudeCodeUsage("plain text, no json")).toBeUndefined();
    expect(parseClaudeCodeUsage(JSON.stringify({ type: "result" }))).toBeUndefined();
    expect(parseClaudeCodeUsage(JSON.stringify({ usage: "nope" }))).toBeUndefined();
    expect(parseClaudeCodeUsage(JSON.stringify({ usage: {} }))).toBeUndefined();
  });
});

describe("getSpendMeter", () => {
  it("meters codex and claude, and abstains for zero-spend/unknown agents", () => {
    expect(getSpendMeter("codex").parse(CODEX_ONE_TURN, "")?.totalTokens).toBe(2000);
    expect(getSpendMeter("claude").parse(CLAUDE_RESULT_JSON, "")?.totalTokens).toBe(1800);
    // claude's meter abstains on non-JSON (e.g. a subscription run's plain -p output).
    expect(getSpendMeter("claude").parse("plain output", "")).toBeUndefined();
    expect(getSpendMeter("script").parse(CODEX_ONE_TURN, "")).toBeUndefined();
    expect(getSpendMeter("nope").parse(CODEX_ONE_TURN, "")).toBeUndefined();
  });
});
