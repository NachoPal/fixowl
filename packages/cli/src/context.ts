import { dirname, join } from "node:path";
import type { Octokit } from "@octokit/rest";
import type { GlobalConfig } from "@fixowl/core";
import { CONFIG_PATH, loadConfig, SECRETS_PATH, type LoadedConfig } from "./config-load.ts";
import { githubClient } from "./github/client.ts";
import { log } from "./log.ts";

export interface CliContext extends LoadedConfig {
  /**
   * Admin Octokit (the setup-only PAT with Administration: write). Built LAZILY:
   * `admin_token` is optional (docs/security.md tells operators to revoke and
   * remove it after setup), so accessing this getter THROWS when the token is
   * absent. Only the provisioning paths (`fixowl provision`,
   * `fixowl start --register`) may touch it unguarded; routine commands
   * (`start`, `fallback check`, `status`) must either not use it or soft-fail on
   * the throw. See the AGENTS.md "admin token is setup-only" invariant.
   */
  readonly admin: Octokit;
}

/**
 * Thrown when a command reaches for the admin client but `admin_token` is not
 * configured. Phrased so an operator who revoked the PAT after setup (as
 * docs/security.md instructs) knows exactly when they need to restore it.
 */
export const ADMIN_TOKEN_MISSING_MESSAGE =
  "github.admin_token is not configured. It is setup-only and revocable " +
  "(see docs/security.md): only `fixowl provision` and `fixowl start --register` need it. " +
  "Add FIXOWL_ADMIN_TOKEN to ~/.fixowl/secrets.env and " +
  "github.admin_token: ${FIXOWL_ADMIN_TOKEN} to config.yaml to run those, then remove it again.";

export function makeContext(configPath?: string): CliContext {
  const resolvedConfig = configPath ?? CONFIG_PATH;
  const secretsPath =
    configPath !== undefined ? join(dirname(configPath), "secrets.env") : SECRETS_PATH;
  const loaded = loadConfig(resolvedConfig, secretsPath);
  for (const warning of loaded.warnings) log.warn(warning);
  let cachedAdmin: Octokit | undefined;
  return {
    ...loaded,
    get admin(): Octokit {
      const token = loaded.config.github.admin_token;
      if (token === undefined || token === "") throw new Error(ADMIN_TOKEN_MISSING_MESSAGE);
      cachedAdmin ??= githubClient(token);
      return cachedAdmin;
    },
  };
}

/**
 * Fail fast in the setup-only paths (provision, `start --register`) when the
 * admin token is absent, so they error with a clear message before doing any
 * work rather than partway through. Returns the admin client for convenience.
 */
export function requireAdmin(ctx: CliContext): Octokit {
  return ctx.admin;
}

/** All configured repos, or just the one named on the command line. */
export function targetRepos(config: GlobalConfig, repoArg?: string): string[] {
  if (repoArg === undefined) return config.repos.map((repo) => repo.name);
  if (!config.repos.some((repo) => repo.name === repoArg)) {
    throw new Error(
      `repo "${repoArg}" is not in the config (known: ${config.repos.map((r) => r.name).join(", ")})`,
    );
  }
  return [repoArg];
}

/** The fixowl action reference provisioned into workflow files. */
export const ACTION_REPO = "NachoPal/fixowl";
