import { realpathSync } from "node:fs";
import {
  decideFallbackDispatch,
  fallbackGapMinutes,
  resolveRepoSettings,
  SCHEDULED_FALLBACK_SOURCE,
  type WorkflowRunLite,
} from "@fixowl/core";
import { targetRepos, type CliContext } from "../context.ts";
import { githubClient } from "../github/client.ts";
import { describeGitHubError } from "../github/errors.ts";
import { splitRepoFullName, type RepoRef } from "../github/repo-provisioning.ts";
import { log } from "../log.ts";
import {
  FALLBACK_PATH_ENV,
  fallbackLabel,
  fallbackLocalTime,
  fallbackLogPath,
  fallbackPlistPath,
  hostMaxOffsetMinutes,
  installFallbackAgent,
  isFallbackInstalled,
  isFallbackLoaded,
  nextFireTime,
  parseDailyCron,
  readPlistLocalTime,
  renderFallbackPlist,
  uninstallFallbackAgent,
  type LocalTime,
} from "../runner/fallback-launchd.ts";

/** Side effects `fallback check` performs; injectable so the decision is testable. */
export interface FallbackCheckDeps {
  listRecentRuns: (ref: RepoRef) => Promise<WorkflowRunLite[]>;
  getDefaultBranch: (ref: RepoRef) => Promise<string>;
  dispatch: (ref: RepoRef, branch: string) => Promise<void>;
  now: () => Date;
}

function requireFallbackToken(ctx: CliContext): string {
  const token = ctx.config.github.fallback_token;
  if (token === undefined || token === "") {
    throw new Error(
      "the local fallback needs github.fallback_token (a fine-grained PAT with " +
        "Actions: write on the target repos). Add FIXOWL_FALLBACK_TOKEN to " +
        "~/.fixowl/secrets.env and github.fallback_token: ${FIXOWL_FALLBACK_TOKEN} " +
        "to config.yaml, or re-run `fixowl init` to set it up.",
    );
  }
  return token;
}

/** Real GitHub-backed deps for `fallback check`, authed with the fallback token. */
export function realFallbackCheckDeps(ctx: CliContext): FallbackCheckDeps {
  const octokit = githubClient(requireFallbackToken(ctx));
  return {
    async listRecentRuns(ref) {
      const { data } = await octokit.rest.actions.listWorkflowRuns({
        ...ref,
        workflow_id: "fixowl.yml",
        per_page: 50,
      });
      return data.workflow_runs.map((run) => ({
        id: run.id,
        event: run.event,
        status: run.status ?? null,
        createdAt: run.created_at,
        displayTitle: run.display_title ?? run.name ?? "",
      }));
    },
    async getDefaultBranch(ref) {
      const { data } = await octokit.rest.repos.get({ ...ref });
      return data.default_branch;
    },
    async dispatch(ref, branch) {
      await octokit.rest.actions.createWorkflowDispatch({
        ...ref,
        workflow_id: "fixowl.yml",
        ref: branch,
        inputs: { source: SCHEDULED_FALLBACK_SOURCE },
      });
    },
    now: () => new Date(),
  };
}

/**
 * The check-then-dispatch the launchd agent runs. For each repo: dispatch the
 * workflow only when today's scheduled (cron) run is missing, tagging the
 * dispatch so the in-run budget guard treats it as the scheduled slot. Logs
 * clearly whether it fired or stood down, so the launchd log is auditable.
 */
export async function fallbackCheckCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  deps: FallbackCheckDeps = realFallbackCheckDeps(ctx),
): Promise<void> {
  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    const ref = splitRepoFullName(repoFullName);
    try {
      const runs = await deps.listRecentRuns(ref);
      const schedule = resolveRepoSettings(ctx.config, repoFullName).schedule;
      const decision = decideFallbackDispatch(runs, deps.now(), schedule);
      if (!decision.dispatch) {
        log.info(`${repoFullName}: skip - ${decision.reason}`);
        continue;
      }
      const branch = await deps.getDefaultBranch(ref);
      await deps.dispatch(ref, branch);
      log.ok(`${repoFullName}: dispatched fallback run - ${decision.reason}`);
    } catch (error) {
      const detail = describeGitHubError(error);
      const hint = /unexpected inputs/i.test(detail)
        ? " (the workflow predates the fallback; run `fixowl provision` to update it)"
        : "";
      log.error(`${repoFullName}: fallback check failed - ${detail}${hint}`);
      process.exitCode = 1;
    }
  }
}

/** argv the launchd agent uses to invoke this CLI: node + the resolved entry. */
function cliInvocation(configPath: string | undefined): string[] {
  const script = realpathSync(process.argv[1] ?? "");
  const configArgs = configPath !== undefined ? ["--config", configPath] : [];
  return [process.execPath, script, ...configArgs, "fallback", "check"];
}

function repoLocalTime(ctx: CliContext, repoFullName: string): LocalTime {
  const cron = parseDailyCron(resolveRepoSettings(ctx.config, repoFullName).schedule);
  return fallbackLocalTime({
    cron,
    gapMinutes: fallbackGapMinutes(ctx.config),
    maxOffsetMinutes: hostMaxOffsetMinutes(),
  });
}

function fmtLocalTime(local: LocalTime): string {
  return `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
}

export async function fallbackInstallCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  configPath: string | undefined,
): Promise<void> {
  requireFallbackToken(ctx);
  if (process.platform !== "darwin") {
    throw new Error(
      "fixowl fallback install currently supports macOS (launchd) only; " +
        "on Linux add a cron/systemd-timer that runs `fixowl fallback check` after the cron.",
    );
  }
  const invocation = cliInvocation(configPath);
  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    const local = repoLocalTime(ctx, repoFullName);
    const label = fallbackLabel(repoFullName);
    const plist = renderFallbackPlist({
      label,
      programArguments: [...invocation, repoFullName],
      local,
      pathEnv: FALLBACK_PATH_ENV,
      stdoutPath: fallbackLogPath(label),
      stderrPath: fallbackLogPath(label),
    });
    await installFallbackAgent({ label, plist });
    log.ok(
      `${repoFullName}: fallback installed, fires daily at ${fmtLocalTime(local)} local ` +
        `(~${fallbackGapMinutes(ctx.config)} min after the cron); next ${nextFireTime(local).toLocaleString()}`,
    );
    log.info(`  logs: ${fallbackLogPath(label)}`);
  }
}

export async function fallbackUninstallCommand(
  ctx: CliContext,
  repoArg: string | undefined,
): Promise<void> {
  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    const removed = await uninstallFallbackAgent(fallbackLabel(repoFullName));
    log.info(
      removed
        ? `${repoFullName}: fallback uninstalled`
        : `${repoFullName}: no fallback was installed`,
    );
  }
}

export async function fallbackStatusCommand(
  ctx: CliContext,
  repoArg: string | undefined,
): Promise<void> {
  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    log.info(`\n${repoFullName}`);
    const label = fallbackLabel(repoFullName);
    if (!isFallbackInstalled(label)) {
      log.info("  fallback: not installed");
      continue;
    }
    const loaded = await isFallbackLoaded(label);
    const local = readPlistLocalTime(label) ?? repoLocalTime(ctx, repoFullName);
    log.info(
      `  fallback: installed${loaded ? "" : " (not loaded)"}, fires daily at ` +
        `${fmtLocalTime(local)} local; next ${nextFireTime(local).toLocaleString()}`,
    );
    log.info(`  plist: ${fallbackPlistPath(label)}`);
  }
}
