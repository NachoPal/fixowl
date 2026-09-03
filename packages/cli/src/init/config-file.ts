import { FIXOWL_DEFAULTS } from "@fixowl/core";

/**
 * Pure rendering for the files `fixowl init` writes. Kept free of I/O and of
 * prompting so the wizard's output can be tested directly.
 */

export interface RepoAnswers {
  name: string;
  /** 5-field cron, UTC (GitHub's schedule timezone). */
  schedule: string;
  /** Human note for the cron comment, e.g. "02:37 Europe/Madrid". */
  scheduleNote?: string;
  labels: string[];
  maxIssuesPerRun: number;
  /** Default model for issues with no selector label. */
  defaultModel?: string;
  /** Default reasoning effort for issues with no selector label. */
  defaultEffort?: string;
  /** Selector-label -> {model, effort}, rendered as `label_models`. */
  labelModels?: Record<string, { model: string; effort: string }>;
}

export interface ConfigAnswers {
  agent: string;
  agentEnv: readonly string[];
  repos: RepoAnswers[];
}

const YAML_PLAIN = /^[A-Za-z][\w.-]*$/;

/** Renders a scalar plain when that is unambiguous, double-quoted otherwise. */
function yamlScalar(value: string): string {
  const reserved = new Set(["true", "false", "null", "yes", "no", "on", "off"]);
  return YAML_PLAIN.test(value) && !reserved.has(value.toLowerCase())
    ? value
    : JSON.stringify(value);
}

function labelRule(labels: readonly string[]): string {
  return `{ any: [${labels.map(yamlScalar).join(", ")}] }`;
}

function cronLine(indent: string, repo: RepoAnswers): string {
  const note = repo.scheduleNote !== undefined ? ` - ${repo.scheduleNote}` : "";
  return `${indent}schedule: "${repo.schedule}"${" ".repeat(Math.max(1, 14 - repo.schedule.length))}# UTC${note}`;
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, index) => label === b[index]);
}

/** Renders the `label_models:` block for a repo (per-repo, never in defaults). */
function labelModelsBlock(indent: string, labelModels: RepoAnswers["labelModels"]): string[] {
  if (labelModels === undefined || Object.keys(labelModels).length === 0) return [];
  const lines = [`${indent}label_models:`];
  for (const [label, choice] of Object.entries(labelModels)) {
    lines.push(
      `${indent}  ${yamlScalar(label)}: { model: ${yamlScalar(choice.model)}, effort: ${yamlScalar(choice.effort)} }`,
    );
  }
  return lines;
}

/** Per-repo override lines: only fields that differ from the defaults (the base repo). */
function repoOverrideLines(repo: RepoAnswers, base: RepoAnswers): string[] {
  const lines: string[] = [];
  if (repo.schedule !== base.schedule) lines.push(cronLine("    ", repo));
  if (!sameLabels(repo.labels, base.labels)) lines.push(`    labels: ${labelRule(repo.labels)}`);
  if (repo.maxIssuesPerRun !== base.maxIssuesPerRun) {
    lines.push(`    max_issues_per_run: ${repo.maxIssuesPerRun}`);
  }
  if (repo.defaultModel !== base.defaultModel && repo.defaultModel !== undefined) {
    lines.push(`    model: ${yamlScalar(repo.defaultModel)}`);
  }
  if (repo.defaultEffort !== base.defaultEffort && repo.defaultEffort !== undefined) {
    lines.push(`    effort: ${yamlScalar(repo.defaultEffort)}`);
  }
  lines.push(...labelModelsBlock("    ", repo.labelModels));
  return lines;
}

export function renderConfigYaml(answers: ConfigAnswers): string {
  const [base, ...rest] = answers.repos;
  if (base === undefined) throw new Error("fixowl needs at least one repo");

  const repoBlocks = [
    // The base repo defines the defaults, so its scalar fields are omitted here;
    // label_models are per-repo and always rendered on the entry itself.
    [`  - name: ${base.name}`, ...labelModelsBlock("    ", base.labelModels)].join("\n"),
    ...rest.map((repo) => [`  - name: ${repo.name}`, ...repoOverrideLines(repo, base)].join("\n")),
  ];

  const defaultModelLines: string[] = [];
  if (base.defaultModel !== undefined) {
    defaultModelLines.push(`  model: ${yamlScalar(base.defaultModel)}`);
  }
  if (base.defaultEffort !== undefined) {
    defaultModelLines.push(`  effort: ${yamlScalar(base.defaultEffort)}`);
  }
  const defaultModelBlock = defaultModelLines.length > 0 ? `\n${defaultModelLines.join("\n")}` : "";

  return `# fixowl configuration, written by \`fixowl init\`. Secrets live in secrets.env next
# to this file and are referenced as \${VAR}; this file never contains raw secrets.
version: 1

github:
  admin_token: \${FIXOWL_ADMIN_TOKEN}      # fine-grained PAT, CLI machine only
  runtime_token: \${FIXOWL_RUNTIME_TOKEN}  # fine-grained PAT, pushed to repos as an Actions secret

# runner:
#   dir: ${FIXOWL_DEFAULTS.runnerDir}   # must live under $HOME (Colima shares $HOME with its VM)

# Defaults for every repo below; each repo may override any of them.
defaults:
${cronLine("  ", base)}
  labels: ${labelRule(base.labels)}
  agent: ${answers.agent}
  max_issues_per_run: ${base.maxIssuesPerRun}
  issue_timeout_minutes: ${FIXOWL_DEFAULTS.issueTimeoutMinutes}${defaultModelBlock}

# Per-agent env allowlist: the ONLY env vars entering per-issue containers.
agents:
  ${answers.agent}: { env: [${answers.agentEnv.join(", ")}] }

repos:
${repoBlocks.join("\n")}
`;
}

const SECRETS_HEADER = `# fixowl secrets - keep this file mode 600. config.yaml references these as
# \${VAR}; agent env vars listed here are sealed into each repo as Actions secrets.
`;

/** Known keys first so the file reads in setup order, then anything else, sorted. */
const SECRET_ORDER = ["FIXOWL_ADMIN_TOKEN", "FIXOWL_RUNTIME_TOKEN"];

export function renderSecretsEnv(values: Record<string, string>): string {
  const known = SECRET_ORDER.filter((name) => name in values);
  const others = Object.keys(values)
    .filter((name) => !SECRET_ORDER.includes(name))
    .toSorted();
  const lines = [...known, ...others].map((name) => `${name}=${values[name] ?? ""}`);
  return `${SECRETS_HEADER}${lines.join("\n")}\n`;
}

export interface ParsedSchedule {
  /** 5-field cron in UTC. */
  cron: string;
  /** Set when the answer was a local time we converted. */
  note?: string;
}

const CRON_FIELDS = /^\S+ \S+ \S+ \S+ \S+$/;
const LOCAL_TIME = /^(\d{1,2}):(\d{2})$/;

export interface ParseScheduleOptions {
  /** Date whose UTC offset is used for the conversion; defaults to now. */
  reference?: Date;
  timeZone?: string;
}

/**
 * Accepts either a local `HH:MM` (converted to a nightly UTC cron, since GitHub
 * schedules are UTC) or a raw 5-field cron, which is passed through as UTC.
 * Throws with a user-facing message so prompt validators can show it.
 */
export function parseSchedule(answer: string, options: ParseScheduleOptions = {}): ParsedSchedule {
  const trimmed = answer.trim();
  if (CRON_FIELDS.test(trimmed)) return { cron: trimmed };
  const match = LOCAL_TIME.exec(trimmed);
  if (match === null) {
    throw new Error('expected a local time like "02:37", or a 5-field UTC cron like "37 1 * * *"');
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("hours must be 0-23 and minutes 0-59");

  const local = new Date(options.reference ?? new Date());
  local.setHours(hour, minute, 0, 0);
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    cron: `${local.getUTCMinutes()} ${local.getUTCHours()} * * *`,
    note: `${pad(hour)}:${pad(minute)} ${zone}`,
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Splits a comma-separated label answer, dropping blanks and duplicates. */
export function parseLabels(answer: string): string[] {
  const labels = answer
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");
  return [...new Set(labels)];
}
