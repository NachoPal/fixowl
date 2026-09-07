import {
  getAgentAdapter,
  resolvedModelSelectionErrors,
  resolveRepoSettings,
  runnerBaseDir,
} from "@fixowl/core";
import type { Octokit } from "@octokit/rest";
import type { CliContext } from "../context.ts";
import { checkDockerEngine } from "../docker/engine-check.ts";
import { resolvePrivateKey, toPkcs8Pem } from "../github/app-key.ts";
import { appClient, githubClient } from "../github/client.ts";
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
  await validateRuntimeCredential(ctx, failed);

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

/**
 * Validate the runtime credential's identity. The PAT tier authenticates with
 * `GET /user` as before. The App tier CANNOT call `GET /user` (an installation
 * token has no user), so it branches to the App's own identity (`GET /app`),
 * confirms the installation exists, and - the honest pre-flight for the whole
 * reason to use an App - confirms it holds `Checks: read` (else the CI gate
 * silently degrades at 2am) and is installed on each configured repo.
 */
export async function validateRuntimeCredential(
  ctx: CliContext,
  failed: (message: string) => void,
): Promise<void> {
  const appConfig = ctx.config.github.app;
  if (appConfig === undefined) {
    const pat = ctx.config.github.runtime_token;
    if (pat === undefined) {
      failed("no runtime credential configured: set github.runtime_token or github.app");
      return;
    }
    try {
      const { data } = await githubClient(pat).rest.users.getAuthenticated();
      log.ok(`runtime token: authenticated as ${data.login}`);
    } catch (error) {
      failed(`runtime token: ${describeGitHubError(error)}`);
    }
    return;
  }

  let client: Octokit;
  try {
    client = appClient({
      kind: "app",
      appId: Number(appConfig.app_id),
      installationId: Number(appConfig.installation_id),
      privateKey: toPkcs8Pem(resolvePrivateKey(appConfig.private_key)),
    });
  } catch (error) {
    failed(`runtime App private key: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const { data: appMeta } = await client.rest.apps.getAuthenticated();
    log.ok(`runtime App: ${appMeta?.slug ?? "?"} (id ${appMeta?.id ?? appConfig.app_id})`);
  } catch (error) {
    failed(`runtime App identity (GET /app): ${describeGitHubError(error)}`);
    return; // if we cannot even authenticate as the App, the rest will only add noise
  }

  const installationId = Number(appConfig.installation_id);
  try {
    const { data: install } = await client.rest.apps.getInstallation({
      installation_id: installationId,
    });
    const checks = install.permissions?.checks;
    if (checks === "read" || checks === "write") {
      log.ok(`runtime App installation ${installationId}: Checks: ${checks}`);
    } else {
      failed(
        `runtime App is missing "Checks: read" (installation ${installationId}); the CI gate ` +
          "will degrade to a settle-then-ready no-op. Grant the App Checks: read.",
      );
    }
    if (install.permissions?.contents !== "write") {
      failed(
        `runtime App is missing "Contents: write" (installation ${installationId}); ` +
          "pushes will fail at night. Grant the App Contents: write.",
      );
    }
    if (install.permissions?.pull_requests !== "write") {
      failed(
        `runtime App is missing "Pull requests: write" (installation ${installationId}); ` +
          "opening PRs will fail at night. Grant the App Pull requests: write.",
      );
    }
  } catch (error) {
    failed(
      `runtime App installation ${installationId} (GET /app/installations/{id}): ` +
        describeGitHubError(error),
    );
    return;
  }

  await validateAppRepoAccess(client, ctx, failed);
}

/** Confirm the App installation can reach each configured repo (else it 404s mid-night). */
async function validateAppRepoAccess(
  client: Octokit,
  ctx: CliContext,
  failed: (message: string) => void,
): Promise<void> {
  let accessible: Set<string>;
  try {
    const repos = await client.paginate(client.rest.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    accessible = new Set(repos.map((repo) => repo.full_name));
  } catch (error) {
    failed(`runtime App: cannot list installation repositories: ${describeGitHubError(error)}`);
    return;
  }
  for (const repoEntry of ctx.config.repos) {
    if (accessible.has(repoEntry.name)) {
      log.ok(`runtime App: installed on ${repoEntry.name}`);
    } else {
      failed(`runtime App is not installed on ${repoEntry.name}; install it on that repo`);
    }
  }
}
