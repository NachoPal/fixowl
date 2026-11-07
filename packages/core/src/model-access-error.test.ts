import { describe, expect, it } from "vitest";
import { detectModelAccessError } from "./model-access-error.ts";

// Real example from issue #149 (codex, run 34503861484): gpt-5-codex is
// verification-gated, so it passes GET /v1/models but 404s on /v1/responses.
const CODEX_404 =
  "ERROR: stream error: stream disconnected before completion: " +
  "404 Not Found: The model gpt-5-codex does not exist or you do not have access to it.";

describe("detectModelAccessError", () => {
  it("turns a provider 404 'model does not exist or no access' error into a clear line", () => {
    expect(detectModelAccessError(CODEX_404, "gpt-5-codex")).toBe(
      "Model 'gpt-5-codex' is not available to your API key (provider returned 404). " +
        "Choose a different model with `fixowl edit`, or complete OpenAI org verification for gated models.",
    );
  });

  it("falls back to the name the provider's own message used when no model was configured", () => {
    expect(detectModelAccessError(CODEX_404, undefined)).toContain("Model 'gpt-5-codex'");
  });

  it("prefers the configured model over a differently-named match in the output", () => {
    expect(detectModelAccessError(CODEX_404, "o3-mini")).toContain("Model 'o3-mini'");
  });

  it("does not match a 404 unrelated to model access", () => {
    expect(
      detectModelAccessError("404 Not Found: no such endpoint", "gpt-5-codex"),
    ).toBeUndefined();
  });

  it("does not match the 'does not exist' phrase without a 404 status", () => {
    const noStatus = "The model gpt-5-codex does not exist or you do not have access to it.";
    expect(detectModelAccessError(noStatus, "gpt-5-codex")).toBeUndefined();
  });

  it("returns undefined for an unrelated failure", () => {
    expect(detectModelAccessError("agent exploded: rate limited", "gpt-5-codex")).toBeUndefined();
  });
});
