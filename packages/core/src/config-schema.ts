import { z } from "zod";
import { validateModelEffort } from "./agent-catalog.ts";
import { labelRuleSchema, type LabelRule } from "./labels.ts";
import type { LabelModelMap } from "./model-selection.ts";

/** 5-field cron expression; correctness beyond shape is GitHub's problem. */
const cronSchema = z.string().regex(/^\S+ \S+ \S+ \S+ \S+$/, "expected a 5-field cron expression");

const envVarNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "expected an ENV_VAR_NAME");

export const repoFullNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo");

const agentSettingsSchema = z.object({
  env: z.array(envVarNameSchema),
});

/** A model + reasoning effort a selector label maps to; both required. */
const modelEffortSchema = z.object({
  model: z.string().min(1),
  effort: z.string().min(1),
});

/**
 * Selector labels: a single GitHub label name -> the model + effort it selects.
 * Dedicated model-selector labels, separate from the issue-pickup label rule.
 */
const labelModelsSchema = z.record(z.string().min(1), modelEffortSchema);

const repoEntrySchema = z.object({
  name: repoFullNameSchema,
  schedule: cronSchema.optional(),
  labels: labelRuleSchema.optional(),
  agent: z.string().optional(),
  max_issues_per_run: z.number().int().positive().optional(),
  issue_timeout_minutes: z.number().int().positive().optional(),
  /** Default model for this repo when an issue carries no selector label. */
  model: z.string().min(1).optional(),
  /** Default reasoning effort for this repo when an issue carries no selector label. */
  effort: z.string().min(1).optional(),
  /** Model-selector labels for this repo (see labelModelsSchema). */
  label_models: labelModelsSchema.optional(),
});

export { labelModelsSchema };

/** `~/.fixowl/config.yaml`, after ${VAR} references are resolved. Never contains raw secrets on disk. */
export const globalConfigSchema = z.object({
  version: z.literal(1),
  github: z.object({
    admin_token: z.string().min(1),
    runtime_token: z.string().min(1),
    /**
     * Least-privilege PAT for the optional local fallback trigger: Actions:
     * write only, used solely to dispatch the workflow when the cron misses.
     * Separate from the setup-only admin token and the minimal runtime token.
     */
    fallback_token: z.string().min(1).optional(),
  }),
  runner: z
    .object({
      dir: z.string().min(1).optional(),
    })
    .optional(),
  /** The optional host-local fallback trigger (`fixowl fallback`). */
  fallback: z
    .object({
      /** Minutes after each repo's cron to run the local backup check. */
      gap_minutes: z.number().int().positive().optional(),
    })
    .optional(),
  defaults: z
    .object({
      schedule: cronSchema.optional(),
      labels: labelRuleSchema.optional(),
      agent: z.string().optional(),
      max_issues_per_run: z.number().int().positive().optional(),
      issue_timeout_minutes: z.number().int().positive().optional(),
      /** Fallback model used by any repo that does not set its own. */
      model: z.string().min(1).optional(),
      /** Fallback reasoning effort used by any repo that does not set its own. */
      effort: z.string().min(1).optional(),
    })
    .optional(),
  agents: z.record(z.string(), agentSettingsSchema).optional(),
  repos: z.array(repoEntrySchema).min(1),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type RepoEntry = z.infer<typeof repoEntrySchema>;

/**
 * Semantic check layered on top of the shape: every configured model/effort
 * must be valid for the agent the repo actually uses. This is the strict
 * variant; the normal load path (`loadConfig`) parses with the shape-only
 * `globalConfigSchema`, and `fixowl validate` surfaces these problems via
 * `resolvedModelSelectionErrors`. Use this schema for fail-fast parse
 * validation (and in tests) when an invalid model/effort must reject at parse.
 */
export const globalConfigSchemaChecked = globalConfigSchema.superRefine((config, ctx) => {
  for (const entry of config.repos) {
    let settings: ResolvedRepoSettings;
    try {
      settings = resolveRepoSettings(config, entry.name);
    } catch {
      continue; // a malformed entry is already reported by the base schema
    }
    for (const message of resolvedModelSelectionErrors(settings)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `repo ${entry.name}: ${message}` });
    }
  }
});

export const FIXOWL_DEFAULTS = {
  schedule: "37 1 * * *",
  labels: { any: ["overnight"] } satisfies LabelRule,
  agent: "claude",
  maxIssuesPerRun: 4,
  issueTimeoutMinutes: 45,
  runnerDir: "~/.fixowl/runners",
  /**
   * Minutes after the cron the local fallback fires. Generous on purpose:
   * GitHub schedules also arrive late, and the check-then-dispatch logic makes
   * exact timing non-critical as long as the fallback is reliably after the cron
   * window. See docs/local-fallback.md.
   */
  fallbackGapMinutes: 30,
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
  /** Default model when an issue carries no selector label; undefined uses the agent CLI default. */
  defaultModel: string | undefined;
  /** Default reasoning effort when an issue carries no selector label; undefined uses the agent CLI default. */
  defaultEffort: string | undefined;
  /** Model-selector labels for this repo; empty when none configured. */
  labelModels: LabelModelMap;
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
    defaultModel: entry.model ?? defaults.model,
    defaultEffort: entry.effort ?? defaults.effort,
    // Selector labels are per-repo by design; they are not merged from defaults.
    labelModels: entry.label_models ?? {},
  };
}

/**
 * Every model/effort chosen for a repo - its default and each selector label -
 * validated against the agent that repo runs. Returns one message per problem.
 */
export function resolvedModelSelectionErrors(settings: ResolvedRepoSettings): string[] {
  const errors = validateModelEffort(settings.agent, {
    model: settings.defaultModel,
    effort: settings.defaultEffort,
  });
  for (const [label, choice] of Object.entries(settings.labelModels)) {
    for (const message of validateModelEffort(settings.agent, choice)) {
      errors.push(`selector label "${label}": ${message}`);
    }
  }
  return errors;
}

export function runnerBaseDir(config: GlobalConfig): string {
  return config.runner?.dir ?? FIXOWL_DEFAULTS.runnerDir;
}

/** Minutes after the cron the local fallback trigger fires. */
export function fallbackGapMinutes(config: GlobalConfig): number {
  return config.fallback?.gap_minutes ?? FIXOWL_DEFAULTS.fallbackGapMinutes;
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
