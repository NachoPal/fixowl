import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { globalConfigSchema, type GlobalConfig } from "@fixowl/core";
import { parse as parseYaml } from "yaml";

export const FIXOWL_DIR = join(homedir(), ".fixowl");
export const CONFIG_PATH = join(FIXOWL_DIR, "config.yaml");
export const SECRETS_PATH = join(FIXOWL_DIR, "secrets.env");

/** Parses KEY=VALUE lines; blank lines and #-comments are ignored. */
export function parseSecretsEnv(content: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [index, rawLine] of content.split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new Error(`secrets.env line ${index + 1} is not KEY=VALUE`);
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    secrets[key] = value;
  }
  return secrets;
}

/**
 * Replaces ${VAR} references in every string of the parsed YAML document with
 * values from secrets.env, so the config file itself never contains secrets.
 */
export function substituteSecretRefs(value: unknown, secrets: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replaceAll(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => {
      const secret = secrets[name];
      if (secret === undefined) {
        throw new Error(`config references \${${name}} but secrets.env does not define it`);
      }
      return secret;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteSecretRefs(item, secrets));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteSecretRefs(item, secrets)]),
    );
  }
  return value;
}

export function loadSecrets(secretsPath = SECRETS_PATH): Record<string, string> {
  if (!existsSync(secretsPath)) return {};
  return parseSecretsEnv(readFileSync(secretsPath, "utf8"));
}

export interface LoadedConfig {
  config: GlobalConfig;
  secrets: Record<string, string>;
  warnings: string[];
}

export function loadConfig(configPath = CONFIG_PATH, secretsPath = SECRETS_PATH): LoadedConfig {
  if (!existsSync(configPath)) {
    throw new Error(`${configPath} not found; run \`fixowl init\` first`);
  }
  const warnings: string[] = [];
  if (existsSync(secretsPath)) {
    const mode = statSync(secretsPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(
        `${secretsPath} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${secretsPath}`,
      );
    }
  }
  const secrets = loadSecrets(secretsPath);
  const raw: unknown = parseYaml(readFileSync(configPath, "utf8"));
  const config = globalConfigSchema.parse(substituteSecretRefs(raw, secrets));
  return { config, secrets, warnings };
}
