import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoFileConfig } from "@fixowl/core";
import { containerName } from "./container-exec.ts";
import type { ContainerEngine, Logger } from "./deps.ts";
import type { CheckOutcome } from "./pr-body.ts";

const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

/** Longest captured check output carried in a `CheckOutcome.log` (fed back to the agent). */
const CHECK_LOG_MAX = 8000;

function tailLog(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined.length <= CHECK_LOG_MAX
    ? combined
    : `...(truncated)...\n${combined.slice(-CHECK_LOG_MAX)}`;
}

/**
 * Runs the target repo's verification in fresh containers (same image, no
 * agent credentials). Verification is a capability, not a mandate: an empty
 * `verify.checks` records no outcomes and never fails the issue. fixowl stays
 * agnostic about *how* a PR is verified - it runs the commands you declare and
 * nothing more (a browser screenshot is just another `checks` entry against an
 * image you supply).
 */
export async function runVerification(params: {
  engine: ContainerEngine;
  log: Logger;
  image: string;
  workspaceDir: string;
  evidenceDir: string;
  repoFullName: string;
  issueNumber: number;
  verify: RepoFileConfig["verify"];
}): Promise<CheckOutcome[]> {
  const { engine, log, image, workspaceDir, evidenceDir, repoFullName, issueNumber, verify } =
    params;
  const outcomes: CheckOutcome[] = [];
  const checks = verify?.checks ?? [];
  if (checks.length === 0) return outcomes;

  mkdirSync(evidenceDir, { recursive: true });

  for (const check of checks) {
    log.info(`verify: running check "${check.name}"`);
    const result = await engine.run({
      image,
      name: containerName(repoFullName, issueNumber, `check-${check.name}`),
      workspaceDir,
      argv: ["bash", "-lc", check.run],
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    writeFileSync(
      join(evidenceDir, `check-${sanitize(check.name)}.log`),
      `$ ${check.run}\n\n${result.stdout}\n${result.stderr}\n(exit ${result.code}${result.timedOut ? ", timed out" : ""})\n`,
    );
    const passed = result.code === 0 && !result.timedOut;
    outcomes.push({
      name: check.name,
      status: passed ? "passed" : "failed",
      detail: result.timedOut ? "timed out" : undefined,
      log: passed ? undefined : `$ ${check.run}\n${tailLog(result.stdout, result.stderr)}`,
    });
  }

  return outcomes;
}

function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
