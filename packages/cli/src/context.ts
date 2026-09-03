import { dirname, join } from "node:path";
import type { Octokit } from "@octokit/rest";
import type { GlobalConfig } from "@fixowl/core";
import { CONFIG_PATH, loadConfig, SECRETS_PATH, type LoadedConfig } from "./config-load.ts";
import { githubClient } from "./github/client.ts";
import { log } from "./log.ts";

export interface CliContext extends LoadedConfig {
  admin: Octokit;
}

export function makeContext(configPath?: string): CliContext {
  const resolvedConfig = configPath ?? CONFIG_PATH;
  const secretsPath =
    configPath !== undefined ? join(dirname(configPath), "secrets.env") : SECRETS_PATH;
  const loaded = loadConfig(resolvedConfig, secretsPath);
  for (const warning of loaded.warnings) log.warn(warning);
  return { ...loaded, admin: githubClient(loaded.config.github.admin_token) };
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
