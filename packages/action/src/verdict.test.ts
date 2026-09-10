import { describe, expect, it } from "vitest";
import { parseVerdict } from "./verdict.ts";

describe("parseVerdict", () => {
  it("parses a clean marker line", () => {
    const out = parseVerdict(
      'FIXOWL_VERDICT: {"verdict":"already-implemented","explanation":"already there in config.ts"}',
    );
    expect(out).toEqual({
      verdict: "already-implemented",
      explanation: "already there in config.ts",
    });
  });

  it("reads the LAST marker when the agent was chatty", () => {
    const stdout = [
      "I looked at the code.",
      'FIXOWL_VERDICT: {"verdict":"not-implemented"}',
      "...actually, on reflection:",
      'FIXOWL_VERDICT: {"verdict":"partial","explanation":"added the missing branch"}',
    ].join("\n");
    expect(parseVerdict(stdout)).toEqual({
      verdict: "partial",
      explanation: "added the missing branch",
    });
  });

  it("tolerates prose and braces after the marker on the same line", () => {
    const out = parseVerdict(
      'done. FIXOWL_VERDICT: {"verdict":"not-applicable"} - hope that helps',
    );
    expect(out).toEqual({ verdict: "not-applicable", explanation: undefined });
  });

  it("returns undefined when there is no marker", () => {
    expect(parseVerdict("I fixed the bug and ran the tests.")).toBeUndefined();
  });

  it("returns undefined for an unknown verdict value", () => {
    expect(parseVerdict('FIXOWL_VERDICT: {"verdict":"maybe"}')).toBeUndefined();
  });

  it("returns undefined for malformed JSON after the marker", () => {
    expect(parseVerdict("FIXOWL_VERDICT: {verdict: already}")).toBeUndefined();
  });

  it("caps a very long explanation", () => {
    const long = "x".repeat(2000);
    const out = parseVerdict(`FIXOWL_VERDICT: {"verdict":"partial","explanation":"${long}"}`);
    expect(out?.explanation?.length).toBe(500);
  });

  it("drops an empty explanation to undefined", () => {
    expect(parseVerdict('FIXOWL_VERDICT: {"verdict":"partial","explanation":"   "}')).toEqual({
      verdict: "partial",
      explanation: undefined,
    });
  });
});
