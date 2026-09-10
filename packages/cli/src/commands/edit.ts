import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FIXOWL_DEFAULTS,
  globalConfigSchemaChecked,
  labelsInRule,
  resolveRepoSettings,
  type GlobalConfig,
  type LabelModelMap,
  type ResolvedRepoSettings,
  type ScheduleTrigger,
} from "@fixowl/core";
import { isScalar, parseDocument, parse as parseYaml, type Document } from "yaml";
import { CONFIG_PATH, SECRETS_PATH, substituteSecretRefs } from "../config-load.ts";
import { makeContext, targetRepos, type CliContext } from "../context.ts";
import { renderSecretsEnv } from "../init/config-file.ts";
import { log } from "../log.ts";
import { createPrompter, type Prompter } from "../prompt.ts";
import {
  promptRepoSettings,
  renderActionsNeeded,
  stepAgent,
  type RepoSettingsAnswers,
  type RepoSettingsPrefill,
} from "./init.ts";
import { provisionCommand } from "./provision.ts";

export interface EditOptions {
  /** Path to config.yaml; secrets.env is read and written next to it. */
  configPath?: string;
  /** Prompter override for tests; defaults to the real interactive prompter. */
  prompter?: Prompter;
}

/** A coding-agent switch to apply to a repo entry: the new agent and its env allowlist. */
interface AgentSwitch {
  agent: string;
  env: string[];
}

/**
 * `fixowl edit [repo]` - interactively update an already-configured repo's
 * settings, then optionally re-provision. Unlike `init`, it never re-onboards:
 * it assumes config.yaml + secrets.env exist and the App/runner are set up, and
 * only edits the per-repo config fields (plus a gated coding-agent switch).
 *
 * The write-back is surgical: the config Document is parsed with `parseDocument`
 * so comments and untouched keys survive, only the fields the user actually
 * changed are mutated, and a per-repo key is dropped when its new value equals
 * the resolved default. The produced text is re-validated before it overwrites
 * the real file.
 *
 * Limitation: the config schema has no per-repo opt-out when a `defaults:` value
 * is set, so blanking an optional field (usage budget, run budget, model,
 * effort) that has an active default makes this repo INHERIT that default rather
 * than opt out; the write-back warns when that happens.
 */
export async function editCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  options: EditOptions = {},
): Promise<void> {
  const injected = options.prompter;
  if (injected === undefined && process.stdin.isTTY !== true) {
    throw new Error(
      "fixowl edit needs an interactive terminal; hand-edit ~/.fixowl/config.yaml " +
        "and run `fixowl provision` instead",
    );
  }
  // Validate the optional [repo] argument up front (throws on an unknown repo).
  if (repoArg !== undefined) targetRepos(ctx.config, repoArg);

  const configPath = options.configPath ?? CONFIG_PATH;
  const secretsPath =
    options.configPath !== undefined ? join(dirname(configPath), "secrets.env") : SECRETS_PATH;

  const prompter = injected ?? createPrompter();
  try {
    await runEditWizard(prompter, ctx, repoArg, configPath, secretsPath);
  } finally {
    if (injected === undefined) prompter.close();
  }
}

async function runEditWizard(
  prompter: Prompter,
  ctx: CliContext,
  repoArg: string | undefined,
  configPath: string,
  secretsPath: string,
): Promise<void> {
  log.info(`
🦉 fixowl edit

Update an existing repo's config field by field - each prompt is pre-filled with
the current value; press Enter to keep it, or type a new one to change it.
Nothing is written until you're done, and the file's comments are preserved.`);

  let text = readFileSync(configPath, "utf8");
  // A mutable copy of the secrets; the gated agent switch adds the new agent's
  // credential to it, and it is written back only if that happens.
  const secrets = { ...ctx.secrets };
  let secretsChanged = false;
  let editedAny = false;

  let nextRepoArg = repoArg;
  for (;;) {
    const repo = nextRepoArg ?? (await chooseRepo(prompter, ctx.config));
    nextRepoArg = undefined; // the [repo] arg only preselects the first iteration

    const current = resolveRepoSettings(ctx.config, repo);
    log.info(`\nEditing ${repo} (agent: ${current.agent})`);

    let agentSwitch: AgentSwitch | undefined;
    let agent = current.agent;
    if (await prompter.confirm("Change the coding agent for this repo?", false)) {
      const picked = await stepAgent(prompter, secrets);
      secretsChanged = true;
      agent = picked.agent;
      agentSwitch = { agent, env: [...picked.agentEnv] };
    }

    // A switched agent has its own model catalog, so start model selection fresh
    // rather than offering to keep a model/effort that may be invalid for it.
    const prefill = toPrefill(current);
    if (agentSwitch !== undefined) {
      prefill.defaultModel = undefined;
      prefill.defaultEffort = undefined;
      prefill.labelModels = undefined;
    }
    // The resolved env allowlist makes the spend-cap prompt auth-aware: a
    // switched agent uses its freshly-picked env, otherwise the repo's current
    // resolved env (so claude-on-API-key keeps offering the token budget).
    const agentEnv = agentSwitch?.env ?? current.agentEnv;
    const answers = await promptRepoSettings(prompter, ctx.admin, agent, repo, prefill, agentEnv);
    const result = applyRepoEditToText(text, ctx.config, repo, answers, agentSwitch);
    text = result.text;
    editedAny = editedAny || result.changed;

    if (!(await prompter.confirm("\nEdit another repository?", false))) break;
  }

  if (editedAny) {
    // Re-validate the produced text before overwriting the real file: a bad edit
    // must never leave an unloadable config on disk.
    assertValidConfig(text, secrets);
    writeFileSync(configPath, text);
    log.ok(`updated ${configPath}`);
    if (secretsChanged) {
      writeFileSync(secretsPath, renderSecretsEnv(secrets), { mode: 0o600 });
      chmodSync(secretsPath, 0o600);
      log.ok(`updated ${secretsPath} (mode 600)`);
    }
  } else {
    log.info("\nNo changes made.");
  }

  await offerProvision(prompter, configPath);
}

async function chooseRepo(prompter: Prompter, config: GlobalConfig): Promise<string> {
  return await prompter.choose(
    "\nWhich repository do you want to edit?",
    config.repos.map((repo) => ({ value: repo.name, label: repo.name })),
  );
}

/** The current resolved settings, as the keep-or-change prefill for the prompts. */
function toPrefill(current: ResolvedRepoSettings): RepoSettingsPrefill {
  return {
    schedule: current.schedule,
    scheduleTrigger: current.scheduleTrigger,
    labels: labelsInRule(current.labels).join(", "),
    maxIssuesPerRun: current.maxIssuesPerRun,
    usageBudgetPercent: current.usageBudgetPercent,
    totalTokenBudget: current.totalTokenBudget,
    runBudgetMinutes: current.runBudgetMinutes,
    issueTimeoutMinutes: current.issueTimeoutMinutes,
    ciMaxTries: current.ciMaxTries,
    ciTimeoutMinutes: current.ciTimeoutMinutes,
    heuristicConflictOrdering: current.heuristicConflictOrdering,
    defaultModel: current.defaultModel,
    defaultEffort: current.defaultEffort,
    labelModels:
      Object.keys(current.labelModels).length > 0 ? { ...current.labelModels } : undefined,
  };
}

/**
 * Apply one repo's edit to the config TEXT, surgically. Parses the text with
 * `parseDocument` (comments and untouched keys survive), applies the optional
 * agent switch and the field change-set, and returns the produced text plus
 * whether anything changed. Operates only on the passed text (no file I/O), so
 * `edit` threads the text through the repo loop and tests can exercise the
 * write-back directly; the one side effect is a `log.warn` when blanking an
 * optional field would make the repo inherit an active default (see below).
 */
export function applyRepoEditToText(
  configText: string,
  config: GlobalConfig,
  repo: string,
  answers: RepoSettingsAnswers,
  agentSwitch?: AgentSwitch,
): { text: string; changed: boolean } {
  const doc = parseDocument(configText);
  const index = config.repos.findIndex((entry) => entry.name === repo);
  if (index < 0) throw new Error(`repo "${repo}" is not listed in config`);
  const current = resolveRepoSettings(config, repo);

  let changed = false;
  if (agentSwitch !== undefined) {
    applyAgentSwitch(doc, index, agentSwitch.agent, agentSwitch.env, config);
    changed = true;
  }
  changed = applyRepoChanges(doc, index, current, answers, config) || changed;
  return { text: doc.toString(), changed };
}

/** The effective default value of each per-repo field (defaults block, then built-in). */
interface RepoDefaults {
  schedule: string;
  scheduleTrigger: ScheduleTrigger;
  labels: string[];
  agent: string;
  maxIssuesPerRun: number;
  usageBudgetPercent: number | undefined;
  totalTokenBudget: number | undefined;
  runBudgetMinutes: number | undefined;
  issueTimeoutMinutes: number;
  ciMaxTries: number;
  ciTimeoutMinutes: number;
  heuristicConflictOrdering: boolean;
  model: string | undefined;
  effort: string | undefined;
}

function repoDefaults(config: GlobalConfig): RepoDefaults {
  const d = config.defaults ?? {};
  return {
    schedule: d.schedule ?? FIXOWL_DEFAULTS.schedule,
    scheduleTrigger: d.schedule_trigger ?? FIXOWL_DEFAULTS.scheduleTrigger,
    labels: labelsInRule(d.labels ?? FIXOWL_DEFAULTS.labels),
    agent: d.agent ?? FIXOWL_DEFAULTS.agent,
    maxIssuesPerRun: d.max_issues_per_run ?? FIXOWL_DEFAULTS.maxIssuesPerRun,
    usageBudgetPercent: d.usage_budget_percent,
    totalTokenBudget: d.total_token_budget,
    runBudgetMinutes: d.run_budget_minutes,
    issueTimeoutMinutes: d.issue_timeout_minutes ?? FIXOWL_DEFAULTS.issueTimeoutMinutes,
    ciMaxTries: d.ci_max_tries ?? FIXOWL_DEFAULTS.ciMaxTries,
    ciTimeoutMinutes: d.ci_timeout_minutes ?? FIXOWL_DEFAULTS.ciTimeoutMinutes,
    heuristicConflictOrdering:
      d.heuristic_conflict_ordering ?? FIXOWL_DEFAULTS.heuristicConflictOrdering,
    model: d.model,
    effort: d.effort,
  };
}

/**
 * Apply the change-set for one repo to the Document. Only fields the user
 * actually changed away from `current` are written, and the placement rule keeps
 * the file tidy: a changed value equal to the resolved default drops the
 * per-repo key (inherit) instead of writing a redundant override. Returns
 * whether anything was written.
 */
function applyRepoChanges(
  doc: Document,
  index: number,
  current: ResolvedRepoSettings,
  answers: RepoSettingsAnswers,
  config: GlobalConfig,
): boolean {
  const d = repoDefaults(config);
  let changed = false;

  // Set the per-repo key, or drop it when the new value equals the default.
  const place = (key: string, value: unknown, isDefault: boolean): void => {
    if (isDefault) doc.deleteIn(["repos", index, key]);
    else doc.setIn(["repos", index, key], value);
    changed = true;
  };

  if (answers.schedule !== current.schedule) {
    if (answers.schedule === d.schedule) {
      doc.deleteIn(["repos", index, "schedule"]);
    } else {
      // Mutate the existing scalar in place when present so its trailing
      // `# UTC - <note>` comment survives a schedule change; fall back to
      // setIn when the repo had no schedule key (nothing to preserve).
      const node = doc.getIn(["repos", index, "schedule"], true);
      if (isScalar(node)) node.value = answers.schedule;
      else doc.setIn(["repos", index, "schedule"], answers.schedule);
    }
    changed = true;
  }
  if (answers.scheduleTrigger !== current.scheduleTrigger) {
    place(
      "schedule_trigger",
      answers.scheduleTrigger,
      answers.scheduleTrigger === d.scheduleTrigger,
    );
  }
  const newLabels = answers.labels;
  if (!arraysEqual(newLabels, labelsInRule(current.labels))) {
    place("labels", { any: newLabels }, arraysEqual(newLabels, d.labels));
  }
  if (answers.maxIssuesPerRun !== current.maxIssuesPerRun) {
    place(
      "max_issues_per_run",
      answers.maxIssuesPerRun,
      answers.maxIssuesPerRun === d.maxIssuesPerRun,
    );
  }
  if (answers.usageBudgetPercent !== current.usageBudgetPercent) {
    placeOptional(
      doc,
      index,
      "usage_budget_percent",
      answers.usageBudgetPercent,
      d.usageBudgetPercent,
    );
    changed = true;
  }
  if (answers.totalTokenBudget !== current.totalTokenBudget) {
    placeOptional(doc, index, "total_token_budget", answers.totalTokenBudget, d.totalTokenBudget);
    changed = true;
  }
  if (answers.runBudgetMinutes !== current.runBudgetMinutes) {
    placeOptional(doc, index, "run_budget_minutes", answers.runBudgetMinutes, d.runBudgetMinutes);
    changed = true;
  }
  const newIssueTimeout = answers.issueTimeoutMinutes ?? current.issueTimeoutMinutes;
  if (newIssueTimeout !== current.issueTimeoutMinutes) {
    place("issue_timeout_minutes", newIssueTimeout, newIssueTimeout === d.issueTimeoutMinutes);
  }
  const newCiMaxTries = answers.ciMaxTries ?? current.ciMaxTries;
  if (newCiMaxTries !== current.ciMaxTries) {
    place("ci_max_tries", newCiMaxTries, newCiMaxTries === d.ciMaxTries);
  }
  const newCiTimeout = answers.ciTimeoutMinutes ?? current.ciTimeoutMinutes;
  if (newCiTimeout !== current.ciTimeoutMinutes) {
    place("ci_timeout_minutes", newCiTimeout, newCiTimeout === d.ciTimeoutMinutes);
  }
  const newHeuristic = answers.heuristicConflictOrdering ?? false;
  if (newHeuristic !== current.heuristicConflictOrdering) {
    place(
      "heuristic_conflict_ordering",
      newHeuristic,
      newHeuristic === d.heuristicConflictOrdering,
    );
  }
  if (answers.defaultModel !== current.defaultModel) {
    placeOptional(doc, index, "model", answers.defaultModel, d.model);
    changed = true;
  }
  if (answers.defaultEffort !== current.defaultEffort) {
    placeOptional(doc, index, "effort", answers.defaultEffort, d.effort);
    changed = true;
  }
  const newLabelModels = answers.labelModels ?? {};
  if (!labelModelsEqual(newLabelModels, current.labelModels)) {
    if (Object.keys(newLabelModels).length === 0) doc.deleteIn(["repos", index, "label_models"]);
    else doc.setIn(["repos", index, "label_models"], newLabelModels);
    changed = true;
  }

  return changed;
}

/**
 * Place an optional field: undefined (blank) or a value equal to the default
 * drops the per-repo key; any other value writes it. `label_models` has no
 * default inheritance, so it is handled inline in `applyRepoChanges`.
 *
 * Blanking a field that has an ACTIVE default does NOT opt the repo out - the
 * schema has no per-repo opt-out - it makes the repo inherit the default, so
 * that case emits a one-line warning before dropping the key.
 */
function placeOptional(
  doc: Document,
  index: number,
  key: string,
  value: number | string | undefined,
  defaultValue: number | string | undefined,
): void {
  if (value === undefined && defaultValue !== undefined) {
    log.warn(
      `clearing this repo's "${key}" override makes it INHERIT the default (${defaultValue}), ` +
        "not opt out - a single repo cannot opt out of a value set in the defaults: block",
    );
  }
  if (value === undefined || value === defaultValue) doc.deleteIn(["repos", index, key]);
  else doc.setIn(["repos", index, key], value);
}

/** Write the per-repo `agent` key (dropped when it equals the default) and the `agents:` block. */
function applyAgentSwitch(
  doc: Document,
  index: number,
  agent: string,
  agentEnv: string[],
  config: GlobalConfig,
): void {
  if (agent === repoDefaults(config).agent) doc.deleteIn(["repos", index, "agent"]);
  else doc.setIn(["repos", index, "agent"], agent);
  doc.setIn(["agents", agent], { env: agentEnv });
}

/** Re-parse the produced YAML through the strict schema; throws with a clear message on failure. */
function assertValidConfig(text: string, secrets: Record<string, string>): void {
  let resolved: unknown;
  try {
    resolved = substituteSecretRefs(parseYaml(text), secrets);
  } catch (error) {
    throw new Error(
      `the edited config could not be parsed, so it was NOT written: ${describeError(error)}`,
      { cause: error },
    );
  }
  const result = globalConfigSchemaChecked.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.message}`).join("\n");
    throw new Error(`the edited config is invalid, so it was NOT written:\n${issues}`);
  }
}

/**
 * Offer to re-provision (skippable). Uses `noRegister: true`: the runner was
 * registered at init, so editing config only needs the admin PAT's write scopes,
 * NOT Administration: write (the admin-token-is-setup-only invariant). Reads a
 * fresh context so it provisions from the just-written file.
 */
async function offerProvision(prompter: Prompter, configPath: string): Promise<void> {
  const run = await prompter.confirm(
    "\nRun `fixowl provision` now to upload the changes / open the update PR(s)?",
    true,
  );
  if (!run) {
    log.info("Skipped. Run `fixowl provision` when you're ready to upload the changes.");
    return;
  }
  log.info("\n$ fixowl provision");
  const ctx = makeContext(configPath === CONFIG_PATH ? undefined : configPath);
  const result = await provisionCommand(ctx, undefined, { noRegister: true });
  log.info(renderActionsNeeded(result).block);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function labelModelsEqual(a: LabelModelMap, b: LabelModelMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return (
      right !== undefined &&
      left !== undefined &&
      left.model === right.model &&
      left.effort === right.effort
    );
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
