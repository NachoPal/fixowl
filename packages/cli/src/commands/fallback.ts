import { realpathSync } from "node:fs";
import {
  decideFallbackDispatch,
  decidePrimaryDispatch,
  fallbackGapMinutes,
  hostSchedulerRole,
  resolveRepoSettings,
  SCHEDULED_FALLBACK_SOURCE,
  type FallbackDecision,
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
        conclusion: run.conclusion ?? null,
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
 * The check-then-dispatch the host launchd agent runs. The repo's
 * `schedule_trigger` decides the strategy (see hostSchedulerRole):
 *
 *  - `both` (fallback):   dispatch only when the current occurrence's `schedule`
 *                         (cron) run is missing - back up an unreliable cron.
 *  - `host-scheduler` (primary): the workflow is dispatch-only, so dispatch
 *                         *directly* on schedule, deduping only against a
 *                         scheduled-slot run already covering the occurrence
 *                         (issue #81 - never read "no cron run" as "cron missed").
 *  - `github-cron` (none): never dispatch - this repo relies on GitHub's cron and
 *                         should not have a host agent at all; skip defensively.
 *
 * Either dispatch is tagged so the in-run budget guard treats it as the
 * scheduled slot. Logs clearly whether it fired or stood down.
 */
export async function fallbackCheckCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  deps: FallbackCheckDeps = realFallbackCheckDeps(ctx),
): Promise<void> {
  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    const ref = splitRepoFullName(repoFullName);
    try {
      const settings = resolveRepoSettings(ctx.config, repoFullName);
      const role = hostSchedulerRole(settings.scheduleTrigger);
      if (role === "none") {
        log.info(
          `${repoFullName}: skip - schedule_trigger is "${settings.scheduleTrigger}" ` +
            "(GitHub cron only); the host scheduler is disabled for this repo",
        );
        continue;
      }
      const runs = await deps.listRecentRuns(ref);
      const decision: FallbackDecision =
        role === "primary"
          ? decidePrimaryDispatch(runs, deps.now(), settings.schedule)
          : decideFallbackDispatch(runs, deps.now(), settings.schedule);
      if (!decision.dispatch) {
        log.info(`${repoFullName}: skip - ${decision.reason}`);
        continue;
      }
      const branch = await deps.getDefaultBranch(ref);
      await deps.dispatch(ref, branch);
      const kind = role === "primary" ? "scheduled" : "fallback";
      log.ok(`${repoFullName}: dispatched ${kind} run - ${decision.reason}`);
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
  const settings = resolveRepoSettings(ctx.config, repoFullName);
  const cron = parseDailyCron(settings.schedule);
  // Fallback mode fires a generous gap AFTER the cron so the cron gets first
  // crack; primary mode is the only trigger, so it fires ON the schedule (gap 0).
  const gapMinutes =
    hostSchedulerRole(settings.scheduleTrigger) === "primary" ? 0 : fallbackGapMinutes(ctx.config);
  return fallbackLocalTime({ cron, gapMinutes, maxOffsetMinutes: hostMaxOffsetMinutes() });
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
    const role = hostSchedulerRole(resolveRepoSettings(ctx.config, repoFullName).scheduleTrigger);
    if (role === "none") {
      // A `github-cron` repo relies on GitHub's cron; installing (or arming) a
      // host agent for it would dispatch unwanted nights (issue #81). Skip it.
      log.info(
        `${repoFullName}: skip - schedule_trigger is "github-cron"; no host agent for this repo`,
      );
      continue;
    }
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
    const when =
      role === "primary"
        ? "dispatches the night directly on schedule"
        : `~${fallbackGapMinutes(ctx.config)} min after the cron (fallback)`;
    log.ok(
      `${repoFullName}: host scheduler installed, fires daily at ${fmtLocalTime(local)} local ` +
        `(${when}); next ${nextFireTime(local).toLocaleString()}`,
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
    const role = hostSchedulerRole(resolveRepoSettings(ctx.config, repoFullName).scheduleTrigger);
    const label = fallbackLabel(repoFullName);
    if (!isFallbackInstalled(label)) {
      log.info(
        role === "none"
          ? "  host scheduler: not installed (schedule_trigger: github-cron)"
          : "  host scheduler: not installed",
      );
      continue;
    }
    const loaded = await isFallbackLoaded(label);
    const local = readPlistLocalTime(label) ?? repoLocalTime(ctx, repoFullName);
    const mode = role === "primary" ? "primary dispatch" : "cron fallback";
    log.info(
      `  host scheduler: installed${loaded ? "" : " (not loaded)"} (${mode}), fires daily at ` +
        `${fmtLocalTime(local)} local; next ${nextFireTime(local).toLocaleString()}`,
    );
    log.info(`  plist: ${fallbackPlistPath(label)}`);
  }
}
