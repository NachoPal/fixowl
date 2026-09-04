import { setTimeout as sleep } from "node:timers/promises";
import type { Octokit } from "@octokit/rest";
import { runnerBaseDir } from "@fixowl/core";
import { targetRepos, type CliContext } from "../context.ts";
import { ensureEngineRunning, type EngineStatus } from "../docker/engine-check.ts";
import { describeGitHubError } from "../github/errors.ts";
import { splitRepoFullName, type RepoRef } from "../github/repo-provisioning.ts";
import { findRunner, runnerNameFor, type RunnerInfo } from "../github/runner-registration.ts";
import { log } from "../log.ts";
import {
  ensureRunnerInstalled,
  isRunnerConfigured,
  runnerDirFor,
  writeRunnerEnvFile,
} from "../runner/install.ts";
import { svcInstall, svcStart } from "../runner/launchd.ts";
import { registerRunner, type RegisterRunnerParams } from "../runner/register.ts";

/** Side effects `start` performs; injectable so the flow is unit-testable. */
export interface StartDeps {
  ensureEngineRunning: () => Promise<EngineStatus>;
  ensureRunnerInstalled: (dir: string) => Promise<"installed" | "already">;
  isRunnerConfigured: (dir: string) => boolean;
  registerRunner: (params: RegisterRunnerParams) => Promise<"configured" | "already">;
  writeRunnerEnvFile: (dir: string, dockerHost?: string) => void;
  svcInstall: (dir: string) => Promise<void>;
  svcStart: (dir: string) => Promise<void>;
  findRunner: (admin: Octokit, ref: RepoRef, name: string) => Promise<RunnerInfo | undefined>;
  sleep: (ms: number) => Promise<void>;
}

export interface StartOptions {
  /**
   * Register the runner as part of this start (needs the admin token's
   * Administration: write). Use it to register on a host other than the one you
   * ran `fixowl provision` on. The default `start` never registers.
   */
  register?: boolean;
  /** Overrides for tests; defaults to the real side effects. */
  deps?: Partial<StartDeps>;
}

const defaultDeps: StartDeps = {
  ensureEngineRunning,
  ensureRunnerInstalled,
  isRunnerConfigured,
  registerRunner,
  writeRunnerEnvFile,
  svcInstall,
  svcStart,
  findRunner,
  sleep,
};

export async function startCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  options: StartOptions = {},
): Promise<void> {
  const deps = { ...defaultDeps, ...options.deps };

  const engine = await deps.ensureEngineRunning();
  if (!engine.ok) {
    throw new Error(engine.detail);
  }
  log.ok(`docker: ${engine.detail}`);

  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    log.info(`\nstarting runner for ${repoFullName}`);
    const ref = splitRepoFullName(repoFullName);
    const dir = runnerDirFor(runnerBaseDir(ctx.config), repoFullName);
    const runnerName = runnerNameFor(repoFullName);

    if (options.register === true) {
      // Explicit setup path: register on this host with the admin token.
      await deps.registerRunner({ admin: ctx.admin, ref, dir, repoFullName });
    } else {
      // Routine path: no admin token, no Administration: write. The runner must
      // already be registered (by `fixowl provision`, or `start --register`).
      const install = await deps.ensureRunnerInstalled(dir);
      log.ok(
        install === "installed"
          ? `runner downloaded into ${dir}`
          : `runner already installed in ${dir}`,
      );
      if (!deps.isRunnerConfigured(dir)) {
        throw new Error(
          `runner for ${repoFullName} is not registered on this host. Register it first:\n` +
            `  fixowl provision ${repoFullName}   # on this host (needs admin Administration: write)\n` +
            `  fixowl start --register ${repoFullName}   # to register on a different host\n` +
            `Routine \`fixowl start\` then needs no admin token.`,
        );
      }
      log.ok("runner already registered");
    }

    deps.writeRunnerEnvFile(dir, engine.dockerHost);
    await deps.svcInstall(dir);
    await deps.svcStart(dir);
    log.ok("service installed and started (survives reboots via launchd)");

    await reportOnlineStatus(deps, ctx, ref, runnerName, repoFullName);
  }
}

/**
 * Best-effort online confirmation. Listing runners is an Administration op, so
 * this needs Administration: read on the admin token - which an operator may
 * have revoked or downgraded after provisioning. When the token cannot reach
 * the API we do NOT fail `start`: the service is already installed and started;
 * we just print how to confirm it another way. This is the only reason `start`
 * touches the admin token at all, and it is never fatal.
 */
async function reportOnlineStatus(
  deps: StartDeps,
  ctx: CliContext,
  ref: RepoRef,
  runnerName: string,
  repoFullName: string,
): Promise<void> {
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const runner = await deps.findRunner(ctx.admin, ref, runnerName);
      if (runner?.status === "online") {
        log.ok(`runner ${runnerName} is online`);
        return;
      }
      await deps.sleep(2000);
    }
    log.warn(
      `runner ${runnerName} did not report online within 60s; check \`fixowl logs ${repoFullName} --runner\``,
    );
  } catch (error) {
    log.info(
      `runner service started - could not confirm online status (${describeGitHubError(error)}). ` +
        `Run \`fixowl status\` or check Settings > Actions > Runners to confirm it is online.`,
    );
  }
}
