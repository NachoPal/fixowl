#!/usr/bin/env node
// Live model-validation step (T5-modelvalidate, the live half). Exercises the SAME code path
// `fixowl validate` uses to catch a bogus/deprecated model id before a night run - the
// per-agent live model list (packages/core/src/model-list.ts: getModelListSource("codex") +
// liveModelCheck) - against OpenAI's real /v1/models list, authorized by the real OPENAI_API_KEY.
//
// It is a READ ONLY (OpenAI's model listing does no inference and costs nothing); no PR is
// opened, no agent runs. Two checks, mirroring what validate must guarantee:
//   1. a deliberately BOGUS model id MUST be reported as an error (proves the check has teeth), and
//   2. the CI codex model (gpt-5.4-mini, or E2E_CODEX_MODEL) MUST be present (proves it is reachable
//      by this key without organization verification - the drift guard for the paid-codex scenarios).
//
// Fail-open is the product contract for an UNREACHABLE list (validate warns and defers to the
// catalog). This step, however, exists to exercise the live read, so an unreachable list is a
// STEP failure here (we cannot validate anything) - reported, not silent.
//
// Usage: OPENAI_API_KEY=... node scripts/e2e/validate-models.mjs
import { appendFileSync } from "node:fs";
import { getModelListSource, liveModelCheck } from "../../packages/core/src/model-list.ts";

const CI_MODEL = process.env.E2E_CODEX_MODEL ?? "gpt-5.4-mini";
const BOGUS_MODEL = "fixowl-bogus-model-does-not-exist-000";

const notes = [];
function note(line) {
  notes.push(line);
  console.log(line);
}

// The single injected I/O edge. Per the ModelListProbe contract it must REJECT on a non-2xx or
// transport error so the source reports the list as unreachable.
async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function main() {
  const source = getModelListSource("codex");
  if (source === undefined) {
    note("FAIL: no live model-list source registered for codex");
    return 1;
  }

  const result = await source.list({ env: process.env, fetchJson });
  if (result.ids === undefined) {
    note(`FAIL: live ${source.label} unreachable - ${result.skippedReason ?? "unknown reason"}`);
    note(
      "  (this step needs a working OPENAI_API_KEY and network; the product itself fails open here)",
    );
    return 1;
  }
  note(`live ${source.label}: ${result.ids.length} models served`);

  let ok = true;

  // 1) The bogus id MUST be flagged as an error.
  const bogus = liveModelCheck(source, result, [BOGUS_MODEL]);
  if (bogus.errors.length > 0) {
    note(`PASS: bogus model "${BOGUS_MODEL}" correctly rejected (${bogus.errors.length} error)`);
  } else {
    ok = false;
    note(`FAIL: bogus model "${BOGUS_MODEL}" was NOT rejected (the live check has no teeth)`);
  }

  // 2) The CI model MUST be present (no errors, a confirming info line).
  const ci = liveModelCheck(source, result, [CI_MODEL]);
  if (ci.errors.length === 0 && ci.info.length > 0) {
    note(`PASS: CI model "${CI_MODEL}" is reachable by this key`);
  } else {
    ok = false;
    for (const error of ci.errors) note(`FAIL: ${error}`);
    if (ci.errors.length === 0) note(`FAIL: CI model "${CI_MODEL}" produced no confirmation`);
  }

  return ok ? 0 : 1;
}

const code = await main();

if (process.env.GITHUB_STEP_SUMMARY !== undefined && process.env.GITHUB_STEP_SUMMARY !== "") {
  const heading = code === 0 ? "PASS" : "FAIL";
  const body = [
    `## Live model validation (codex / OpenAI) - ${heading}`,
    "",
    ...notes.map((line) => `- ${line}`),
    "",
  ].join("\n");
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);
  } catch (error) {
    console.error(`could not append to GITHUB_STEP_SUMMARY: ${String(error)}`);
  }
}

process.exit(code);
