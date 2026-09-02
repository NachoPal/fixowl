import { describe, expect, it } from "vitest";
import { buildClassifyPrompt, parseClassification } from "./classify.ts";
import { issue } from "./test-helpers.ts";

describe("parseClassification", () => {
  const selected = [12, 15, 18];

  it("parses a clean JSON object", () => {
    const result = parseClassification(`{"chains": [[12], [15, 18]]}`, selected);
    expect(result).toEqual({ chains: [[12], [15, 18]], fallback: false });
  });

  it("parses JSON surrounded by agent chatter", () => {
    const output = `Sure! Looking at the repo, issues 15 and 18 both touch the editor.\n\n{"chains": [[12], [15, 18]]}\n`;
    const result = parseClassification(output, selected);
    expect(result.fallback).toBe(false);
    expect(result.chains).toEqual([[12], [15, 18]]);
  });

  it("falls back when an issue is missing from the partition", () => {
    const result = parseClassification(`{"chains": [[12], [15]]}`, selected);
    expect(result.fallback).toBe(true);
    expect(result.chains).toEqual([[12], [15], [18]]);
    expect(result.warning).toMatch(/did not partition/);
  });

  it("falls back on duplicates and unknown issues", () => {
    expect(parseClassification(`{"chains": [[12, 12], [15, 18]]}`, selected).fallback).toBe(true);
    expect(parseClassification(`{"chains": [[12], [15, 18, 99]]}`, selected).fallback).toBe(true);
  });

  it("falls back on non-JSON output", () => {
    const result = parseClassification("I could not decide.", selected);
    expect(result.fallback).toBe(true);
    expect(result.chains).toEqual([[12], [15], [18]]);
  });

  it("falls back on wrong shapes", () => {
    expect(parseClassification(`{"chains": "12,15,18"}`, selected).fallback).toBe(true);
    expect(parseClassification(`{"chains": [[]]}`, selected).fallback).toBe(true);
  });
});

describe("buildClassifyPrompt", () => {
  it("fences every issue body and demands pure JSON", () => {
    const prompt = buildClassifyPrompt([issue(1, "a", "body-one"), issue(2, "b", "body-two")]);
    expect(prompt.match(/<untrusted-issue-body>/g)).toHaveLength(2);
    expect(prompt).toContain('{"chains": [[<issue number>, ...], ...]}');
    expect(prompt).toContain("read-only");
  });
});
