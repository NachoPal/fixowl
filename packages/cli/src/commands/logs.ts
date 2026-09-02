import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerBaseDir } from "@fixowl/core";
import type { CliContext } from "../context.ts";
import { runOrThrow } from "../exec.ts";
import { splitRepoFullName } from "../github/repo-provisioning.ts";
import { log } from "../log.ts";
import { runnerDirFor } from "../runner/install.ts";

export async function logsCommand(
  ctx: CliContext,
  repoFullName: string,
  options: { runner?: boolean },
): Promise<void> {
  if (options.runner === true) {
    printRunnerDiagnostics(ctx, repoFullName);
    return;
  }

  const ref = splitRepoFullName(repoFullName);
  const { data } = await ctx.admin.rest.actions.listWorkflowRuns({
    ...ref,
    workflow_id: "fixowl.yml",
    per_page: 1,
  });
  const run = data.workflow_runs[0];
  if (run === undefined) {
    log.info("no fixowl runs yet");
    return;
  }
  log.info(
    `logs for run ${run.html_url} (${run.status}${run.conclusion !== null ? `/${run.conclusion}` : ""})`,
  );

  const { data: zip } = await ctx.admin.rest.actions.downloadWorkflowRunLogs({
    ...ref,
    run_id: run.id,
  });
  const dir = mkdtempSync(join(tmpdir(), "fixowl-logs-"));
  const zipPath = join(dir, "logs.zip");
  writeFileSync(zipPath, Buffer.from(zip as ArrayBuffer));
  await runOrThrow(["unzip", "-o", "-q", zipPath, "-d", dir]);

  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .toSorted()) {
    log.info(`\n===== ${file} =====`);
    process.stdout.write(readFileSync(join(dir, file), "utf8"));
  }
}

function printRunnerDiagnostics(ctx: CliContext, repoFullName: string): void {
  const diagDir = join(runnerDirFor(runnerBaseDir(ctx.config), repoFullName), "_diag");
  let files: string[];
  try {
    files = readdirSync(diagDir).filter((name) => name.endsWith(".log"));
  } catch {
    log.info(`no runner diagnostics at ${diagDir}`);
    return;
  }
  const latest = files
    .map((name) => ({ name, mtime: statSync(join(diagDir, name)).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime)[0];
  if (latest === undefined) {
    log.info(`no runner diagnostics at ${diagDir}`);
    return;
  }
  const content = readFileSync(join(diagDir, latest.name), "utf8");
  const lines = content.split("\n");
  log.info(`===== ${join(diagDir, latest.name)} (last 200 lines) =====`);
  process.stdout.write(lines.slice(-200).join("\n"));
}
