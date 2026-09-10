import { z } from "zod";

/**
 * Layer B verdict contract. The agent verifies against the current code before
 * fixing and prints its verdict as a single marked line to stdout:
 *
 *   FIXOWL_VERDICT: {"verdict":"already-implemented","explanation":"..."}
 *
 * fixowl reads it from stdout (never a workspace file - a file would count as a
 * change and defeat the no-diff check). The verdict is ADVISORY: the no-PR
 * decision is driven by the diff, and a verdict is only used to word the skip
 * comment and to note a partial fix. So a parse miss is safe (it degrades to the
 * conservative no-change path). See docs/issue-triage.md.
 */

/** The marker the agent prints ahead of the verdict JSON. */
export const VERDICT_MARKER = "FIXOWL_VERDICT:";

export const VERDICT_VALUES = [
  "already-implemented",
  "partial",
  "not-implemented",
  "not-applicable",
] as const;
export type VerdictValue = (typeof VERDICT_VALUES)[number];

const EXPLANATION_MAX = 500;

const verdictSchema = z.object({
  verdict: z.enum(VERDICT_VALUES),
  explanation: z.string().optional(),
});

export interface Verdict {
  verdict: VerdictValue;
  explanation?: string;
}

/**
 * Parse the LAST `FIXOWL_VERDICT:` marker in the agent's stdout. Returns
 * undefined when there is no marker or the JSON is unparseable/ill-shaped - the
 * caller then treats the run conservatively. The explanation is trimmed and
 * length-capped here; the caller still sanitizes it for markdown before posting.
 */
export function parseVerdict(stdout: string): Verdict | undefined {
  const markerAt = stdout.lastIndexOf(VERDICT_MARKER);
  if (markerAt < 0) return undefined;
  const after = stdout.slice(markerAt + VERDICT_MARKER.length);
  const parsed = extractFirstJsonObject(after);
  if (parsed === undefined) return undefined;
  const result = verdictSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const explanation = result.data.explanation?.trim();
  return {
    verdict: result.data.verdict,
    explanation:
      explanation !== undefined && explanation !== ""
        ? explanation.slice(0, EXPLANATION_MAX)
        : undefined,
  };
}

/** Extract the first balanced `{...}` object span from `text` and JSON-parse it. */
function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
