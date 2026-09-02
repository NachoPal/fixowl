import { setTimeout as sleep } from "node:timers/promises";
import { runnerBaseDir } from "@fixowl/core";
import { targetRepos, type CliContext } from "../context.ts";
import { ensureEngineRunning } from "../docker/engine-check.ts";
import { splitRepoFullName } from "../github/repo-provisioning.ts";
import { findRunner, getRegistrationToken, runnerNameFor } from "../github/runner-registration.ts";
import { log } from "../log.ts";
import {
  configureRunner,
  ensureRunnerInstalled,
  isRunnerConfigured,
  runnerDirFor,
  writeRunnerEnvFile,
} from "../runner/install.ts";
import { svcInstall, svcStart } from "../runner/launchd.ts";

export async function startCommand(ctx: CliContext, repoArg: string | undefined): Promise<void> {
  const engine = await ensureEngineRunning();
  if (!engine.ok) {
    throw new Error(engine.detail);
  }
  log.ok(`docker: ${engine.detail}`);

  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    log.info(`\nstarting runner for ${repoFullName}`);
    const ref = splitRepoFullName(repoFullName);
    const dir = runnerDirFor(runnerBaseDir(ctx.config), repoFullName);
    const runnerName = runnerNameFor(repoFullName);

    const install = await ensureRunnerInstalled(dir);
    log.ok(
      install === "installed"
        ? `runner downloaded into ${dir}`
        : `runner already installed in ${dir}`,
    );

    if (isRunnerConfigured(dir)) {
      log.ok("runner already registered");
    } else {
      const token = await getRegistrationToken(ctx.admin, ref);
      await configureRunner({ dir, repoFullName, registrationToken: token, runnerName });
      log.ok(`runner registered as ${runnerName} (labels: self-hosted, fixowl)`);
    }

    writeRunnerEnvFile(dir, engine.dockerHost);
    await svcInstall(dir);
    await svcStart(dir);
    log.ok("service installed and started (survives reboots via launchd)");

    const online = await waitForOnline(ctx, ref, runnerName);
    if (online) log.ok(`runner ${runnerName} is online`);
    else
      log.warn(
        `runner ${runnerName} did not report online within 60s; check \`fixowl logs ${repoFullName} --runner\``,
      );
  }
}

async function waitForOnline(
  ctx: CliContext,
  ref: { owner: string; repo: string },
  runnerName: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const runner = await findRunner(ctx.admin, ref, runnerName);
    if (runner?.status === "online") return true;
    await sleep(2000);
  }
  return false;
}
