import { setTimeout as sleep } from "node:timers/promises";
import type { CliContext } from "../context.ts";
import { splitRepoFullName } from "../github/repo-provisioning.ts";
import { log } from "../log.ts";

/** Dispatches the fixowl workflow and follows it to completion. */
export async function runCommand(ctx: CliContext, repoFullName: string): Promise<void> {
  const ref = splitRepoFullName(repoFullName);
  const { data: repoData } = await ctx.admin.rest.repos.get({ ...ref });
  const since = new Date();

  await ctx.admin.rest.actions.createWorkflowDispatch({
    ...ref,
    workflow_id: "fixowl.yml",
    ref: repoData.default_branch,
  });
  log.ok("workflow dispatched; waiting for the run to appear");

  let runId: number | undefined;
  let runUrl = "";
  for (let attempt = 0; attempt < 30 && runId === undefined; attempt++) {
    await sleep(3000);
    const { data } = await ctx.admin.rest.actions.listWorkflowRuns({
      ...ref,
      workflow_id: "fixowl.yml",
      event: "workflow_dispatch",
      per_page: 5,
    });
    const run = data.workflow_runs.find(
      (candidate) => new Date(candidate.created_at).getTime() >= since.getTime() - 10_000,
    );
    if (run !== undefined) {
      runId = run.id;
      runUrl = run.html_url;
    }
  }
  if (runId === undefined) {
    throw new Error(
      "dispatched, but no run appeared within 90s; is the runner online? (fixowl status)",
    );
  }
  log.info(`following ${runUrl}`);

  let lastStatus = "";
  for (;;) {
    const { data: run } = await ctx.admin.rest.actions.getWorkflowRun({ ...ref, run_id: runId });
    if (run.status !== lastStatus && run.status !== null) {
      lastStatus = run.status;
      log.info(`  status: ${run.status}`);
    }
    if (run.status === "completed") {
      const conclusion = run.conclusion ?? "unknown";
      if (conclusion === "success") log.ok(`run completed: ${conclusion}`);
      else log.error(`run completed: ${conclusion}`);
      log.info(`summary and evidence: ${runUrl}`);
      if (conclusion !== "success") process.exitCode = 1;
      return;
    }
    await sleep(5000);
  }
}
