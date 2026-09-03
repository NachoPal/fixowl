import {
  getAgentAdapter,
  resolvedModelSelectionErrors,
  resolveRepoSettings,
  runnerBaseDir,
} from "@fixowl/core";
import type { CliContext } from "../context.ts";
import { checkDockerEngine } from "../docker/engine-check.ts";
import { githubClient } from "../github/client.ts";
import { describeGitHubError } from "../github/errors.ts";
import { splitRepoFullName } from "../github/repo-provisioning.ts";
import { log } from "../log.ts";
import { isUnderHome } from "../runner/install.ts";

export async function validateCommand(ctx: CliContext): Promise<boolean> {
  let ok = true;
  const failed = (message: string): void => {
    ok = false;
    log.error(message);
  };

  // Tokens
  try {
    const { data } = await ctx.admin.rest.users.getAuthenticated();
    log.ok(`admin token: authenticated as ${data.login}`);
  } catch (error) {
    failed(`admin token: ${describeGitHubError(error)}`);
  }
  const runtime = githubClient(ctx.config.github.runtime_token);
  try {
    const { data } = await runtime.rest.users.getAuthenticated();
    log.ok(`runtime token: authenticated as ${data.login}`);
  } catch (error) {
    failed(`runtime token: ${describeGitHubError(error)}`);
  }

  // Repos and per-repo settings
  for (const repoEntry of ctx.config.repos) {
    try {
      const ref = splitRepoFullName(repoEntry.name);
      const { data } = await ctx.admin.rest.repos.get({ ...ref });
      log.ok(`repo ${repoEntry.name}: reachable (default branch ${data.default_branch})`);
    } catch (error) {
      failed(`repo ${repoEntry.name}: ${describeGitHubError(error)}`);
      continue;
    }
    try {
      const settings = resolveRepoSettings(ctx.config, repoEntry.name);
      const adapter = getAgentAdapter(settings.agent, settings.agentEnv);
      const missing = adapter.env.filter(
        (name) => ctx.secrets[name] === undefined && process.env[name] === undefined,
      );
      if (missing.length > 0) {
        failed(
          `repo ${repoEntry.name}: agent "${adapter.name}" needs ${missing.join(", ")} in secrets.env before provisioning`,
        );
      } else {
        log.ok(
          `repo ${repoEntry.name}: agent "${adapter.name}" (env: ${adapter.env.join(", ") || "none"})`,
        );
      }

      // Model/effort choices must be valid for the agent this repo uses.
      const modelErrors = resolvedModelSelectionErrors(settings);
      if (modelErrors.length > 0) {
        for (const message of modelErrors) failed(`repo ${repoEntry.name}: ${message}`);
      } else if (
        settings.defaultModel !== undefined ||
        settings.defaultEffort !== undefined ||
        Object.keys(settings.labelModels).length > 0
      ) {
        const selectors = Object.keys(settings.labelModels);
        log.ok(
          `repo ${repoEntry.name}: model selection ok` +
            (settings.defaultModel !== undefined || settings.defaultEffort !== undefined
              ? ` (default ${settings.defaultModel ?? "-"}/${settings.defaultEffort ?? "-"})`
              : "") +
            (selectors.length > 0 ? ` (selector labels: ${selectors.join(", ")})` : ""),
        );
      }
    } catch (error) {
      failed(`repo ${repoEntry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Docker engine
  const engine = await checkDockerEngine();
  if (engine.ok) log.ok(`docker: ${engine.detail}`);
  else failed(`docker: ${engine.detail}`);

  // Runner dir placement
  const dir = runnerBaseDir(ctx.config);
  if (isUnderHome(dir)) {
    log.ok(`runner dir ${dir} is under $HOME (Colima can mount workspaces)`);
  } else {
    failed(
      `runner dir ${dir} is outside $HOME; Colima's VM cannot see it. Use a path under $HOME.`,
    );
  }

  if (!ok) log.error("validation failed");
  else log.ok("everything checks out");
  return ok;
}
