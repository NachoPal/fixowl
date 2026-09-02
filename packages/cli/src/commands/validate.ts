import { Octokit } from "@octokit/rest";
import { getAgentAdapter, resolveRepoSettings, runnerBaseDir } from "@fixowl/core";
import type { CliContext } from "../context.ts";
import { checkDockerEngine } from "../docker/engine-check.ts";
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
    failed(`admin token: ${describeAuthError(error)}`);
  }
  const runtime = new Octokit({ auth: ctx.config.github.runtime_token });
  try {
    const { data } = await runtime.rest.users.getAuthenticated();
    log.ok(`runtime token: authenticated as ${data.login}`);
  } catch (error) {
    failed(`runtime token: ${describeAuthError(error)}`);
  }

  // Repos and per-repo settings
  for (const repoEntry of ctx.config.repos) {
    try {
      const ref = splitRepoFullName(repoEntry.name);
      const { data } = await ctx.admin.rest.repos.get({ ...ref });
      log.ok(`repo ${repoEntry.name}: reachable (default branch ${data.default_branch})`);
    } catch (error) {
      failed(`repo ${repoEntry.name}: ${describeAuthError(error)}`);
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

function describeAuthError(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (status === 401) return "invalid or expired token (HTTP 401)";
    if (status === 403) return "token lacks permission (HTTP 403)";
    if (status === 404) return "not found or token cannot see it (HTTP 404)";
  }
  return error instanceof Error ? error.message : String(error);
}
