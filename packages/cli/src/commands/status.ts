import { existsSync } from "node:fs";
import { runnerBaseDir, WORKFLOW_ID } from "@fixowl/core";
import { targetRepos, type CliContext } from "../context.ts";
import { describeGitHubError } from "../github/errors.ts";
import { splitRepoFullName } from "../github/repo-provisioning.ts";
import { findRunner, runnerNameFor } from "../github/runner-registration.ts";
import { log } from "../log.ts";
import { runnerDirFor } from "../runner/install.ts";
import { svcStatus } from "../runner/launchd.ts";
import { hostSchedulerStatusLines } from "./host-scheduler.ts";

export async function statusCommand(ctx: CliContext, repoArg: string | undefined): Promise<void> {
  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    log.info(`\n${repoFullName}`);
    const ref = splitRepoFullName(repoFullName);
    const dir = runnerDirFor(runnerBaseDir(ctx.config), repoFullName);

    // Local service
    if (!existsSync(dir)) {
      log.info(`  service: not installed on this machine`);
    } else {
      log.info(`  service: ${await svcStatus(dir)} (${dir})`);
    }

    // Local host scheduler (opt-in). One shared renderer with `fixowl
    // host-scheduler status`, so the two blocks cannot drift.
    for (const line of await hostSchedulerStatusLines(ctx, repoFullName)) log.info(line);

    // Registered runner. Listing runners needs Administration: read; if the
    // admin token was revoked or downgraded below that, report it rather than
    // failing - confirm online status in Settings > Actions > Runners instead.
    try {
      const runner = await findRunner(ctx.admin, ref, runnerNameFor(repoFullName));
      log.info(
        runner !== undefined
          ? `  runner:  ${runner.status}${runner.busy ? " (busy)" : ""}`
          : `  runner:  not registered`,
      );
    } catch (error) {
      log.info(
        `  runner:  unknown - needs Administration: read (${describeGitHubError(error)}); ` +
          `see Settings > Actions > Runners`,
      );
    }

    // Last scheduled/dispatched run
    try {
      const { data } = await ctx.admin.rest.actions.listWorkflowRuns({
        ...ref,
        workflow_id: WORKFLOW_ID,
        per_page: 1,
      });
      const last = data.workflow_runs[0];
      log.info(
        last !== undefined
          ? `  last run: ${last.status}${last.conclusion !== null ? `/${last.conclusion}` : ""} at ${last.created_at} (${last.html_url})`
          : `  last run: none yet`,
      );
    } catch {
      log.info(`  last run: workflow not provisioned yet`);
    }

    // Open fixowl PRs and the public-repo note. These read through the admin
    // client too, so - like the runner/last-run checks above - degrade rather
    // than fail when the setup-only admin token is absent or downgraded.
    try {
      const { data: pulls } = await ctx.admin.rest.pulls.list({
        ...ref,
        state: "open",
        per_page: 100,
      });
      const fixowlPulls = pulls.filter((pull) => pull.head.ref.startsWith("issue/"));
      log.info(`  open fixowl PRs: ${fixowlPulls.length}`);
      for (const pull of fixowlPulls) {
        log.info(`    #${pull.number} ${pull.title} (${pull.head.ref} -> ${pull.base.ref})`);
      }

      const { data: repoData } = await ctx.admin.rest.repos.get({ ...ref });
      if (repoData.private === false) {
        log.info(
          `  note: public repo; GitHub disables the schedule after 60 days without repo activity`,
        );
      }
    } catch (error) {
      log.info(
        `  open fixowl PRs: unknown - needs the admin token (${describeGitHubError(error)}); ` +
          `see the repo's Pull requests tab`,
      );
    }
  }
}
