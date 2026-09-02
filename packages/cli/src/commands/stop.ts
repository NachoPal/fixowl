import { existsSync, rmSync } from "node:fs";
import { runnerBaseDir } from "@fixowl/core";
import { targetRepos, type CliContext } from "../context.ts";
import { splitRepoFullName } from "../github/repo-provisioning.ts";
import {
  findRunner,
  deleteRunner,
  getRemovalToken,
  runnerNameFor,
} from "../github/runner-registration.ts";
import { log } from "../log.ts";
import { isRunnerConfigured, removeRunnerConfig, runnerDirFor } from "../runner/install.ts";
import { svcStop, svcUninstall } from "../runner/launchd.ts";

export async function stopCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  options: { deregister?: boolean },
): Promise<void> {
  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    const dir = runnerDirFor(runnerBaseDir(ctx.config), repoFullName);
    if (!existsSync(dir)) {
      log.info(`${repoFullName}: no runner installed`);
      continue;
    }
    if (options.deregister !== true) {
      await svcStop(dir);
      log.ok(
        `${repoFullName}: runner service stopped (still registered; \`fixowl start\` resumes it)`,
      );
      continue;
    }

    await svcUninstall(dir);
    const ref = splitRepoFullName(repoFullName);
    if (isRunnerConfigured(dir)) {
      try {
        await removeRunnerConfig(dir, await getRemovalToken(ctx.admin, ref));
      } catch (error) {
        log.warn(`config.sh remove failed (${String(error)}); falling back to the API`);
      }
    }
    const runner = await findRunner(ctx.admin, ref, runnerNameFor(repoFullName));
    if (runner !== undefined) {
      await deleteRunner(ctx.admin, ref, runner.id);
    }
    rmSync(dir, { recursive: true, force: true });
    log.ok(`${repoFullName}: runner deregistered and removed`);
  }
}
