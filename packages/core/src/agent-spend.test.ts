import { describe, expect, it } from "vitest";
import { getSpendMeter, parseAiderUsage, parseCodexUsage } from "./agent-spend.ts";

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

describe("parseAiderUsage", () => {
  it("sums each exchange's sent/received tokens, expanding k/M suffixes", () => {
    const out = [
      "Applied edit to foo.ts",
      "Tokens: 1.2k sent, 800 received. Cost: $0.01 message, $0.01 session.",
      "Tokens: 3k sent, 1k received. Cost: $0.02 message, $0.03 session.",
    ].join("\n");
    expect(parseAiderUsage(out)).toEqual({
      totalTokens: 6000, // (1200+800) + (3000+1000)
      inputTokens: 4200,
      cachedInputTokens: 0,
      outputTokens: 1800,
      reasoningOutputTokens: 0,
    });
  });

  it("abstains (undefined) when no Tokens line is present", () => {
    expect(parseAiderUsage("no usage here")).toBeUndefined();
  });
});

describe("getSpendMeter", () => {
  it("meters codex and aider, and abstains for subscription/zero-spend/unknown agents", () => {
    expect(getSpendMeter("codex").parse(CODEX_ONE_TURN, "")?.totalTokens).toBe(2000);
    expect(
      getSpendMeter("aider").parse("Tokens: 1k sent, 0 received. Cost: $0 message, $0 session.", "")
        ?.totalTokens,
    ).toBe(1000);
    expect(getSpendMeter("claude").parse(CODEX_ONE_TURN, "")).toBeUndefined();
    expect(getSpendMeter("script").parse(CODEX_ONE_TURN, "")).toBeUndefined();
    expect(getSpendMeter("nope").parse(CODEX_ONE_TURN, "")).toBeUndefined();
  });
});
