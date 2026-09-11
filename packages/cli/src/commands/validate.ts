import {
  agentBilling,
  getAgentAdapter,
  getModelListSource,
  liveModelCheck,
  resolvedModelSelectionErrors,
  resolveRepoSettings,
  runnerBaseDir,
  type ResolvedRepoSettings,
} from "@fixowl/core";
import type { Octokit } from "@octokit/rest";
import type { CliContext } from "../context.ts";
import { checkDockerEngine } from "../docker/engine-check.ts";
import { resolvePrivateKey, toPkcs8Pem } from "../github/app-key.ts";
import { appClient } from "../github/client.ts";
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

      // Model/effort choices must be valid for the agent this repo uses. This
      // is the hardcoded-catalog check (the safety net); the live provider
      // check below runs on top of it for agents that expose a model list.
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

      // Budget/billing mismatch: `usage_budget_percent` is a subscription
      // usage-window budget and can never be observed for an api-credit agent
      // (codex, or claude on an API key), so at night it would fall through and
      // re-warn every run. Catch it once here and point at `total_token_budget`.
      const presentEnv = adapter.env.filter((name) => !missing.includes(name));
      const budgetWarning = usageBudgetBillingMismatch(settings, presentEnv);
      if (budgetWarning !== undefined) log.warn(`repo ${repoEntry.name}: ${budgetWarning}`);

      // Live provider check: for agents whose provider serves a queryable model
      // list, confirm each chosen id is actually reachable. For those agents the
      // catalog check above defers model-id membership to here (only an invalid
      // effort still fails above), so a live-only codex id reaches this check
      // instead of being short-circuited. Fail-open: an unreachable list warns
      // and falls back to the catalog; a fetched list missing the model fails.
      if (modelErrors.length === 0) {
        await validateModelsAgainstLiveList({
          repoName: repoEntry.name,
          settings,
          env: { ...process.env, ...ctx.secrets },
          fetchJson,
          ok: (message) => log.ok(`repo ${repoEntry.name}: ${message}`),
          warn: (message) => log.warn(`repo ${repoEntry.name}: ${message}`),
          failed: (message) => failed(`repo ${repoEntry.name}: ${message}`),
        });
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
 * Detect a `usage_budget_percent` set for an api-credit agent, which has no
 * observable subscription usage window - so the budget can never apply and the
 * night run would otherwise warn about it on every run. Returns a single
 * actionable message (pointing at `total_token_budget`) or undefined when the
 * config is fine: no usage budget set, or a subscription agent (for which
 * `usage_budget_percent` is correct). Billing is resolved with the same
 * auth-aware `agentBilling` classifier `fixowl init` uses, so claude-on-API-key
 * is caught while claude-on-OAuth is left alone. Exported for direct testing.
 */
export function usageBudgetBillingMismatch(
  settings: ResolvedRepoSettings,
  agentEnv: readonly string[],
): string | undefined {
  if (settings.usageBudgetPercent === undefined) return undefined;
  if (agentBilling(settings.agent, agentEnv) !== "api-credit") return undefined;
  return (
    `usage_budget_percent is set for agent "${settings.agent}", which bills as metered API ` +
    "usage and has no usage window to read - it will never apply. Use total_token_budget " +
    "instead (or remove usage_budget_percent)."
  );
}

/**
 * The single network edge for the live model-list read. Rejects on a non-2xx
 * so the source treats the list as unobservable and the caller falls back to the
 * catalog. This is a free model-listing read (no inference); the pure source in
 * @fixowl/core does no I/O of its own. Shared with the `fixowl init` picker
 * (init.ts) so the two never drift onto separate fetch paths.
 */
export async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Deduped, undefined-free set of model ids configured for a repo: its default
 * model plus each selector-label model. Effort is not a model id and is checked
 * only against the catalog.
 */
function configuredModelIds(settings: ResolvedRepoSettings): string[] {
  const ids = new Set<string>();
  if (settings.defaultModel !== undefined) ids.add(settings.defaultModel);
  for (const choice of Object.values(settings.labelModels)) {
    if (choice.model !== undefined) ids.add(choice.model);
  }
  return [...ids];
}

/**
 * Verify a repo's chosen model ids against the agent provider's live model list.
 * No-op for agents with no queryable list (claude), so the catalog stays
 * their only source of truth. Fail-open per `liveModelCheck`: an unreachable
 * list warns and defers to the catalog; a fetched list missing a model fails.
 * Exported for direct testing with a faked `fetchJson`.
 */
export async function validateModelsAgainstLiveList(params: {
  repoName: string;
  settings: ResolvedRepoSettings;
  env: Record<string, string | undefined>;
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
  ok: (message: string) => void;
  warn: (message: string) => void;
  failed: (message: string) => void;
}): Promise<void> {
  const source = getModelListSource(params.settings.agent);
  if (source === undefined) return; // agent has no live model list; catalog is authoritative
  const models = configuredModelIds(params.settings);
  if (models.length === 0) return; // nothing chosen; the agent CLI default is used

  const result = await source.list({ env: params.env, fetchJson: params.fetchJson });
  const outcome = liveModelCheck(source, result, models);
  for (const message of outcome.info) params.ok(message);
  for (const message of outcome.warnings) params.warn(message);
  for (const message of outcome.errors) params.failed(message);
}

/**
 * Validate the GitHub App runtime credential. An installation token has no
 * user, so this checks the App's own identity (`GET /app`), confirms the
 * installation exists, and - the honest pre-flight for the whole reason to use
 * an App - confirms it holds `Checks: read` (else the CI gate silently degrades
 * at 2am) plus the write permissions the night needs (`Contents: write` for
 * pushes, `Pull requests: write` for PRs), and is installed on each configured
 * repo.
 */
export async function validateRuntimeCredential(
  ctx: CliContext,
  failed: (message: string) => void,
): Promise<void> {
  const appConfig = ctx.config.github.app;

  let client: Octokit;
  try {
    client = appClient({
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
