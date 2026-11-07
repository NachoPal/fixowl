/**
 * Detects a provider's "model does not exist / no access" failure inside an
 * agent's raw captured output, and turns it into one clear, actionable line for
 * the night-run summary instead of the raw provider error (issue #149). Real
 * example (codex, `gpt-5-codex`): the model is verification-gated - it is listed
 * by `GET /v1/models` (and even `GET /v1/models/<id>` returns 200), but the
 * actual `/v1/responses` call 404s with "The model gpt-5-codex does not exist or
 * you do not have access to it". `fixowl validate`'s live model-list check
 * (`model-list.ts`) cannot catch this: listing a model is not the same as this
 * key being allowed to call it. This is the runtime safety net for that gap.
 *
 * Pure text matching, no I/O: the caller (`issue-pipeline.ts`) passes the
 * agent's combined stdout/stderr. Never throws; no match returns `undefined` so
 * the caller falls back to its existing generic error message.
 */
const MODEL_ACCESS_ERROR_PATTERN =
  /model\s+['"`]?([\w.\-:/]+)['"`]?\s+does not exist or you do not have access/i;

/**
 * `configuredModel` (the model fixowl actually resolved for this issue,
 * `ctx.selection.model`) is preferred over whatever the provider's message
 * happened to name, since it is the value the operator would change; it falls
 * back to the matched name only when fixowl left model selection to the agent's
 * own default (so no configured model is in scope).
 */
export function detectModelAccessError(
  output: string,
  configuredModel: string | undefined,
): string | undefined {
  if (!/\b404\b/.test(output)) return undefined;
  const match = MODEL_ACCESS_ERROR_PATTERN.exec(output);
  if (match === null) return undefined;
  const model = configuredModel ?? match[1];
  return (
    `Model '${model}' is not available to your API key (provider returned 404). ` +
    "Choose a different model with `fixowl edit`, or complete OpenAI org verification for gated models."
  );
}
