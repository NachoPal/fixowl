#!/usr/bin/env node
// Extract a codex run's measured token usage from the per-issue EVIDENCE agent logs, reusing the
// PRODUCT's own parser (packages/core/src/agent-spend.ts::parseCodexUsage) so the measurement is
// faithful to how fixowl meters the `total_token_budget` axis in-band. `codex exec --json` (fix
// mode) makes the agent's stdout a JSONL event stream whose `turn.completed` events carry a
// `usage` object; fixowl writes that stdout to <RUNNER_TEMP>/fixowl-evidence/issue-<n>/
// agent-attempt-<k>.log (issue-pipeline.ts), NOT to the action's own stdout - so the paid tier
// points this at those evidence logs. parseCodexUsage sums input + output tokens across every
// event and abstains (returns undefined) on any unexpected shape.
//
// This is test-harness code under scripts/, not product runtime: it only READS logs the paid E2E
// tier already produced and prints the summed sample as JSON (or `null` when nothing measurable
// was found). It doubles as the first real check of parseCodexUsage against live codex output
// (Open risk 1 in the design report: the parser was built to the documented schema).
//
// Usage: node scripts/e2e/paid-usage.mjs <agent-log> [<agent-log> ...]
import { readFileSync } from "node:fs";
import { parseCodexUsage } from "../../packages/core/src/agent-spend.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node scripts/e2e/paid-usage.mjs <agent-log> [<agent-log> ...]");
  process.exit(2);
}

// Concatenate every named log (a codex issue can span multiple fix attempts, one log each) and
// parse the whole stream at once - parseCodexUsage sums turn.completed events across it.
let text = "";
for (const path of paths) {
  try {
    text += readFileSync(path, "utf8") + "\n";
  } catch (error) {
    // A missing/unreadable log is not measurable spend; skip it rather than crash the summary.
    console.error(`paid-usage: could not read ${path}: ${String(error)}`);
  }
}

const sample = parseCodexUsage(text);
console.log(JSON.stringify(sample ?? null));
