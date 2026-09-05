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
  /**
   * Run-budget stop conditions (issue #21), each optional. The night stops on
   * the first that trips; leaving one unset opts that axis out.
   * `max_issues_per_run` is the kept secondary count cap.
   */
  max_issues_per_run: z.number().int().positive().optional(),
  /** Stop before starting a new issue once the agent's usage window hits this % (0..100). */
  usage_budget_percent: z.number().min(0).max(100).optional(),
  /** Graceful wall-clock: don't start a new issue after this many minutes of the run. */
  run_budget_minutes: z.number().int().positive().optional(),
  issue_timeout_minutes: z.number().int().positive().optional(),
  /** Max agent passes in the CI-gated fix loop before a draft PR is left. */
  ci_max_tries: z.number().int().positive().optional(),
  /** Minutes to wait for the required checks on a pushed head before counting the attempt as a CI timeout. */
  ci_timeout_minutes: z.number().int().positive().optional(),
  /** Default model for this repo when an issue carries no selector label. */
  model: z.string().min(1).optional(),
  /** Default reasoning effort for this repo when an issue carries no selector label. */
  effort: z.string().min(1).optional(),
  /** Model-selector labels for this repo (see labelModelsSchema). */
  label_models: labelModelsSchema.optional(),
  /**
   * Opt-in Layer 2: the LLM same-files classifier that groups and stacks
   * non-dependent issues to reduce merge conflicts. Default off; native
   * `blocked_by` ordering (Layer 1) is always-on and unaffected.
   */
  heuristic_conflict_ordering: z.boolean().optional(),
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
      /** Default usage-budget stop % for every repo (issue #21). */
      usage_budget_percent: z.number().min(0).max(100).optional(),
      /** Default graceful wall-clock stop, in minutes, for every repo (issue #21). */
      run_budget_minutes: z.number().int().positive().optional(),
      issue_timeout_minutes: z.number().int().positive().optional(),
      /** Default CI-gated-loop try budget for any repo that does not set its own. */
      ci_max_tries: z.number().int().positive().optional(),
      /** Default CI-gated-loop per-attempt timeout (minutes) for any repo that does not set its own. */
      ci_timeout_minutes: z.number().int().positive().optional(),
      /** Fallback model used by any repo that does not set its own. */
      model: z.string().min(1).optional(),
      /** Fallback reasoning effort used by any repo that does not set its own. */
      effort: z.string().min(1).optional(),
      /** Default Layer 2 (heuristic conflict-ordering) toggle for every repo. */
      heuristic_conflict_ordering: z.boolean().optional(),
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
  /**
   * Starter run-budget values (issue #21), written into a fresh config by
   * `fixowl init` and offered as the wizard's prefilled defaults. They are NOT a
   * resolution fallback: an operator who leaves `usage_budget_percent` /
   * `run_budget_minutes` unset opts that axis out (undefined), so a config
   * written before this feature behaves exactly as it did. 240 min sits
   * comfortably under the workflow's blunt `timeout-minutes: 300` ceiling.
   */
  usageBudgetPercent: 85,
  runBudgetMinutes: 240,
  issueTimeoutMinutes: 45,
  /**
   * Layer 2 (heuristic same-files conflict-ordering) is off by default: fixowl
   * never merges, so it never restacks what it stacks; independent PRs are more
   * robust for piecemeal review; and the classifier is a paid LLM guess. Layer 1
   * native `blocked_by` ordering is always-on and unaffected. See docs/stacked-prs.md.
   */
  heuristicConflictOrdering: false,
  /**
   * CI-gated fix loop: at most this many agent passes before a draft PR is
   * left with the outstanding failures, and how long each pass waits for the
   * pushed head's required checks before counting a CI timeout. See
   * docs/ci-fix-loop.md and issue-pipeline.ts.
   */
  ciMaxTries: 3,
  ciTimeoutMinutes: 60,
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
  /**
   * Usage-budget stop % (issue #21), or undefined to opt the usage condition
   * out. No built-in fallback, so an unset value stays undefined.
   */
  usageBudgetPercent: number | undefined;
  /** Graceful wall-clock stop in minutes (issue #21), or undefined to opt out. */
  runBudgetMinutes: number | undefined;
  issueTimeoutMinutes: number;
  /** Max agent passes in the CI-gated fix loop before leaving a draft PR. */
  ciMaxTries: number;
  /** Minutes each pass waits for the pushed head's required checks. */
  ciTimeoutMinutes: number;
  /** Env allowlist for the agent; undefined means use the adapter's built-in default. */
  agentEnv: string[] | undefined;
  /** Default model when an issue carries no selector label; undefined uses the agent CLI default. */
  defaultModel: string | undefined;
  /** Default reasoning effort when an issue carries no selector label; undefined uses the agent CLI default. */
  defaultEffort: string | undefined;
  /** Model-selector labels for this repo; empty when none configured. */
  labelModels: LabelModelMap;
  /**
   * Whether Layer 2 (the heuristic same-files classifier) runs for this repo.
   * Off by default; Layer 1 native `blocked_by` ordering is always-on regardless.
   */
  heuristicConflictOrdering: boolean;
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
    // Usage % and wall-clock have no built-in fallback: unset stays undefined
    // (opted out), so a pre-#21 config is unchanged. The starter values live in
    // FIXOWL_DEFAULTS only for `init` to write into a fresh config.
    usageBudgetPercent: entry.usage_budget_percent ?? defaults.usage_budget_percent,
    runBudgetMinutes: entry.run_budget_minutes ?? defaults.run_budget_minutes,
    issueTimeoutMinutes:
      entry.issue_timeout_minutes ??
      defaults.issue_timeout_minutes ??
      FIXOWL_DEFAULTS.issueTimeoutMinutes,
    ciMaxTries: entry.ci_max_tries ?? defaults.ci_max_tries ?? FIXOWL_DEFAULTS.ciMaxTries,
    ciTimeoutMinutes:
      entry.ci_timeout_minutes ?? defaults.ci_timeout_minutes ?? FIXOWL_DEFAULTS.ciTimeoutMinutes,
    agentEnv: config.agents?.[agent]?.env,
    defaultModel: entry.model ?? defaults.model,
    defaultEffort: entry.effort ?? defaults.effort,
    // Selector labels are per-repo by design; they are not merged from defaults.
    labelModels: entry.label_models ?? {},
    heuristicConflictOrdering:
      entry.heuristic_conflict_ordering ??
      defaults.heuristic_conflict_ordering ??
      FIXOWL_DEFAULTS.heuristicConflictOrdering,
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
