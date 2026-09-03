import { z } from "zod";
import { labelRuleSchema, type LabelRule } from "./labels.ts";

/** 5-field cron expression; correctness beyond shape is GitHub's problem. */
const cronSchema = z.string().regex(/^\S+ \S+ \S+ \S+ \S+$/, "expected a 5-field cron expression");

const envVarNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "expected an ENV_VAR_NAME");

export const repoFullNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo");

const agentSettingsSchema = z.object({
  env: z.array(envVarNameSchema),
});

const repoEntrySchema = z.object({
  name: repoFullNameSchema,
  schedule: cronSchema.optional(),
  labels: labelRuleSchema.optional(),
  agent: z.string().optional(),
  max_issues_per_run: z.number().int().positive().optional(),
  issue_timeout_minutes: z.number().int().positive().optional(),
});

/** `~/.fixowl/config.yaml`, after ${VAR} references are resolved. Never contains raw secrets on disk. */
export const globalConfigSchema = z.object({
  version: z.literal(1),
  github: z.object({
    admin_token: z.string().min(1),
    runtime_token: z.string().min(1),
  }),
  runner: z
    .object({
      dir: z.string().min(1).optional(),
    })
    .optional(),
  defaults: z
    .object({
      schedule: cronSchema.optional(),
      labels: labelRuleSchema.optional(),
      agent: z.string().optional(),
      max_issues_per_run: z.number().int().positive().optional(),
      issue_timeout_minutes: z.number().int().positive().optional(),
    })
    .optional(),
  agents: z.record(z.string(), agentSettingsSchema).optional(),
  repos: z.array(repoEntrySchema).min(1),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type RepoEntry = z.infer<typeof repoEntrySchema>;

export const FIXOWL_DEFAULTS = {
  schedule: "37 1 * * *",
  labels: { any: ["overnight"] } satisfies LabelRule,
  agent: "claude",
  maxIssuesPerRun: 4,
  issueTimeoutMinutes: 45,
  runnerDir: "~/.fixowl/runners",
} as const;

export interface ResolvedRepoSettings {
  name: string;
  schedule: string;
  labels: LabelRule;
  agent: string;
  maxIssuesPerRun: number;
  issueTimeoutMinutes: number;
  /** Env allowlist for the agent; undefined means use the adapter's built-in default. */
  agentEnv: string[] | undefined;
}

export function resolveRepoSettings(config: GlobalConfig, repoName: string): ResolvedRepoSettings {
  const entry = config.repos.find((repo) => repo.name === repoName);
  if (!entry) {
    throw new Error(
      `repo "${repoName}" is not listed in config (known: ${config.repos.map((r) => r.name).join(", ")})`,
    );
  }
  const defaults = config.defaults ?? {};
  const agent = entry.agent ?? defaults.agent ?? FIXOWL_DEFAULTS.agent;
  return {
    name: entry.name,
    schedule: entry.schedule ?? defaults.schedule ?? FIXOWL_DEFAULTS.schedule,
    labels: entry.labels ?? defaults.labels ?? FIXOWL_DEFAULTS.labels,
    agent,
    maxIssuesPerRun:
      entry.max_issues_per_run ?? defaults.max_issues_per_run ?? FIXOWL_DEFAULTS.maxIssuesPerRun,
    issueTimeoutMinutes:
      entry.issue_timeout_minutes ??
      defaults.issue_timeout_minutes ??
      FIXOWL_DEFAULTS.issueTimeoutMinutes,
    agentEnv: config.agents?.[agent]?.env,
  };
}

export function runnerBaseDir(config: GlobalConfig): string {
  return config.runner?.dir ?? FIXOWL_DEFAULTS.runnerDir;
}

// ---------------------------------------------------------------------------
// Per-target-repo `.fixowl.yml`, versioned with the target's code.
// ---------------------------------------------------------------------------

const verifyCheckSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
});

const webCheckSchema = z.object({
  name: z.string().min(1),
  start: z.string().min(1),
  url: z.string().min(1),
  /** Seconds to wait for the app to become reachable (default 120; cold dev-server compiles can need more). */
  startup_timeout_seconds: z.number().int().positive().optional(),
});

export const repoFileConfigSchema = z.object({
  version: z.literal(1),
  dockerfile: z.string().min(1).optional(),
  verify: z
    .object({
      checks: z.array(verifyCheckSchema).optional(),
      web: z.array(webCheckSchema).optional(),
    })
    .optional(),
  prompt_extra: z.string().optional(),
});

export type RepoFileConfig = z.infer<typeof repoFileConfigSchema>;
export type VerifyCheck = z.infer<typeof verifyCheckSchema>;
export type WebCheck = z.infer<typeof webCheckSchema>;

/** Path of the per-repo config inside the target repository. */
export const REPO_CONFIG_PATH = ".fixowl.yml";
