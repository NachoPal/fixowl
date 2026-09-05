import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoFileConfig } from "@fixowl/core";
import { containerName } from "./container-exec.ts";
import type { ContainerEngine, Logger } from "./deps.ts";
import type { CheckOutcome } from "./pr-body.ts";
import { VERIFY_WEB_SCRIPT, VERIFY_WEB_SCRIPT_MOUNT_PATH } from "./verify-web-script.ts";

export const EVIDENCE_MOUNT_PATH = "/fixowl/evidence";

const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

/** Longest captured check output carried in a `CheckOutcome.log` (fed back to the agent). */
const CHECK_LOG_MAX = 8000;

function tailLog(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined.length <= CHECK_LOG_MAX
    ? combined
    : `...(truncated)...\n${combined.slice(-CHECK_LOG_MAX)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Runs the target repo's verification in fresh containers (same image, no
 * agent credentials). Verification is a capability, not a mandate: a missing
 * capability records "unavailable" and never fails the issue.
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
  const webChecks = verify?.web ?? [];
  if (checks.length === 0 && webChecks.length === 0) return outcomes;

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

  if (webChecks.length > 0) {
    const scriptFile = join(evidenceDir, "verify-web.mjs");
    writeFileSync(scriptFile, VERIFY_WEB_SCRIPT);
    for (const web of webChecks) {
      log.info(`verify: web check "${web.name}" against ${web.url}`);
      const webEvidenceDir = join(evidenceDir, `web-${sanitize(web.name)}`);
      mkdirSync(webEvidenceDir, { recursive: true });
      const command = `( ${web.start} ) >${EVIDENCE_MOUNT_PATH}/app.log 2>&1 & node ${VERIFY_WEB_SCRIPT_MOUNT_PATH} --url ${shellQuote(web.url)} --out ${EVIDENCE_MOUNT_PATH} --deadline ${web.startup_timeout_seconds ?? 120}`;
      const result = await engine.run({
        image,
        name: containerName(repoFullName, issueNumber, `web-${web.name}`),
        workspaceDir,
        argv: ["bash", "-lc", command],
        extraMounts: [
          { host: scriptFile, container: VERIFY_WEB_SCRIPT_MOUNT_PATH, readOnly: true },
          { host: webEvidenceDir, container: EVIDENCE_MOUNT_PATH },
        ],
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      writeFileSync(
        join(webEvidenceDir, "verify.log"),
        `${result.stdout}\n${result.stderr}\n(exit ${result.code}${result.timedOut ? ", timed out" : ""})\n`,
      );
      const outcome = webOutcome(web.name, result.code, result.timedOut);
      if (outcome.status === "failed") {
        outcome.log = tailLog(result.stdout, result.stderr);
      }
      outcomes.push(outcome);
    }
  }

  return outcomes;
}

function webOutcome(name: string, code: number | null, timedOut: boolean): CheckOutcome {
  if (timedOut) return { name, status: "failed", detail: "timed out" };
  if (code === 0) return { name, status: "passed", detail: "screenshot captured" };
  if (code === 3) return { name, status: "unavailable", detail: "playwright not in image" };
  if (code === 2) return { name, status: "failed", detail: "console errors; see evidence" };
  if (code === 1) return { name, status: "failed", detail: "app unreachable" };
  return { name, status: "failed", detail: `exit ${code}` };
}

function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
