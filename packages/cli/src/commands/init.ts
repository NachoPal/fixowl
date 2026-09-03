import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Octokit } from "@octokit/rest";
import {
  agentCatalogEntry,
  getAgentAdapter,
  repoFullNameSchema,
  type AgentCatalogEntry,
} from "@fixowl/core";
import { CONFIG_PATH, loadSecrets, SECRETS_PATH } from "../config-load.ts";
import { makeContext } from "../context.ts";
import { githubClient } from "../github/client.ts";
import { describeGitHubError } from "../github/errors.ts";
import {
  parseLabels,
  parseSchedule,
  renderConfigYaml,
  renderSecretsEnv,
  type RepoAnswers,
} from "../init/config-file.ts";
import { log } from "../log.ts";
import { createPrompter, maskSecret, type Prompter } from "../prompt.ts";
import { provisionCommand } from "./provision.ts";
import { startCommand } from "./start.ts";
import { validateCommand } from "./validate.ts";

const PAT_URL = "https://github.com/settings/personal-access-tokens/new";

/** Agents offered by the wizard. Test-only and paid-API adapters stay out of it. */
const AGENT_CHOICES = [
  {
    value: "claude",
    label: "claude",
    hint: "Claude Code, driven by your Claude subscription token",
  },
] as const;

/** How to obtain each agent credential, keyed by the adapter's env var. */
const AGENT_SECRET_HELP: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN:
    "Run `claude setup-token` in another terminal. It opens a browser and prints a\n" +
    "  long-lived token tied to your Claude subscription.",
};

export interface InitOptions {
  /** Path to config.yaml; secrets.env is read and written next to it. */
  configPath?: string;
  /** Skip the wizard and just scaffold the starter files. */
  nonInteractive?: boolean;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  const configPath = options.configPath ?? CONFIG_PATH;
  const secretsPath =
    options.configPath !== undefined ? join(dirname(configPath), "secrets.env") : SECRETS_PATH;
  mkdirSync(dirname(configPath), { recursive: true });

  if (options.nonInteractive === true || process.stdin.isTTY !== true) {
    scaffoldOnly(configPath, secretsPath);
    return;
  }

  const prompter = createPrompter();
  try {
    await runWizard(prompter, configPath, secretsPath);
  } finally {
    prompter.close();
  }
}

async function runWizard(
  prompter: Prompter,
  configPath: string,
  secretsPath: string,
): Promise<void> {
  log.info(`
🦉 fixowl setup

This walks you through the whole thing: GitHub tokens, the coding agent, the
repos to watch, then validates and provisions them. Nothing is written until
the questions are answered, and every answer is stored in ${dirname(configPath)}.`);

  if (existsSync(configPath)) {
    const existing = await prompter.choose(`\nFound an existing config at ${configPath}.`, [
      { value: "keep", label: "Keep it", hint: "skip ahead to validate and provision" },
      { value: "redo", label: "Start over", hint: "re-answer everything and overwrite it" },
      { value: "cancel", label: "Cancel", hint: "leave everything untouched" },
    ]);
    if (existing === "cancel") {
      log.info("nothing changed");
      return;
    }
    if (existing === "keep") {
      await validateAndProvision(prompter, configPath);
      return;
    }
  }

  const secrets = loadSecrets(secretsPath);
  const admin = await stepTokens(prompter, secrets);
  const { agent, agentEnv } = await stepAgent(prompter, secrets);
  const repos = await stepRepos(prompter, admin, agent);

  writeFileSync(configPath, renderConfigYaml({ agent, agentEnv, repos }));
  log.ok(`wrote ${configPath}`);
  writeFileSync(secretsPath, renderSecretsEnv(secrets), { mode: 0o600 });
  chmodSync(secretsPath, 0o600);
  log.ok(`wrote ${secretsPath} (mode 600)`);

  await validateAndProvision(prompter, configPath);
}

// ---------------------------------------------------------------------------
// Step 1: the two GitHub tokens
// ---------------------------------------------------------------------------

async function stepTokens(prompter: Prompter, secrets: Record<string, string>): Promise<Octokit> {
  log.info(`
Step 1/4  GitHub tokens
-----------------------
fixowl needs two fine-grained personal access tokens, each scoped to ONLY the
repos you want it to touch:

  admin    Administration RW, Secrets RW, Contents RW, Workflows RW,
           Issues RW, Actions RW. Stays on this machine; used to provision.
  runtime  Contents RW, Pull requests RW, Issues RW. Pushed to each repo as an
           Actions secret; this is what the night run uses to push and open PRs.

Mint them at ${PAT_URL}`);
  await prompter.pause("\nPress Enter once you have both tokens ready ");

  const adminToken = await askToken(prompter, {
    label: "  admin token",
    existing: secrets.FIXOWL_ADMIN_TOKEN,
  });
  secrets.FIXOWL_ADMIN_TOKEN = adminToken;
  secrets.FIXOWL_RUNTIME_TOKEN = await askToken(prompter, {
    label: "  runtime token",
    existing: secrets.FIXOWL_RUNTIME_TOKEN,
  });
  return githubClient(adminToken);
}

/** Prompts for a token, checks it against GitHub, and offers a retry when it fails. */
async function askToken(
  prompter: Prompter,
  options: { label: string; existing?: string },
): Promise<string> {
  for (;;) {
    const token = await prompter.secret(options.label, {
      existing: options.existing,
      validate: (value) =>
        /\s/.test(value) ? "a token has no spaces; paste it on one line" : undefined,
    });
    const login = await whoami(token);
    if (login.ok) {
      log.ok(`authenticated as ${login.login}: ${maskSecret(token)}`);
      return token;
    }
    log.warn(`GitHub rejected that token: ${login.reason}`);
    if (!(await prompter.confirm("  Enter it again?", true))) return token;
  }
}

async function whoami(
  token: string,
): Promise<{ ok: true; login: string } | { ok: false; reason: string }> {
  try {
    const { data } = await githubClient(token).rest.users.getAuthenticated();
    return { ok: true, login: data.login };
  } catch (error) {
    return { ok: false, reason: describeGitHubError(error) };
  }
}

// ---------------------------------------------------------------------------
// Step 2: the coding agent and its credential
// ---------------------------------------------------------------------------

async function stepAgent(
  prompter: Prompter,
  secrets: Record<string, string>,
): Promise<{ agent: string; agentEnv: readonly string[] }> {
  log.info(`
Step 2/4  Coding agent
----------------------`);
  const agent = await prompter.choose("Which agent should fix your issues?", [...AGENT_CHOICES]);
  const adapter = getAgentAdapter(agent);

  for (const name of adapter.env) {
    const help = AGENT_SECRET_HELP[name];
    const existing = secrets[name];
    log.info(`\n${agent} needs ${name}.${help !== undefined ? `\n  ${help}` : ""}`);
    if (existing === undefined || existing === "") {
      await prompter.pause("\nPress Enter once you have it ");
    }
    const value = await prompter.secret(`  ${name}`, {
      existing,
      validate: (answer) =>
        /\s/.test(answer) ? "a token has no spaces; paste it on one line" : undefined,
    });
    secrets[name] = value;
    log.ok(`stored ${name}: ${maskSecret(value)}`);
  }
  return { agent, agentEnv: adapter.env };
}

// ---------------------------------------------------------------------------
// Step 3: the repos
// ---------------------------------------------------------------------------

async function stepRepos(
  prompter: Prompter,
  admin: Octokit,
  agent: string,
): Promise<RepoAnswers[]> {
  log.info(`
Step 3/4  Repositories
----------------------
For each repo: which one, when the nightly run fires, which labels mark an
issue as fixowl's, how many issues one night may take on, and which model the
coding agent runs with.`);

  const repos: RepoAnswers[] = [];
  let lastSchedule = "02:37";
  let lastLabels = "overnight";
  let lastMaxIssues = "4";

  for (;;) {
    log.info(`\nRepo ${repos.length + 1}`);
    const name = await askRepoName(prompter, admin, repos);

    const scheduleAnswer = await prompter.ask(
      "  Nightly run time (local HH:MM, or a 5-field UTC cron)",
      {
        default: lastSchedule,
        validate: (value) => problemWith(() => parseSchedule(value)),
      },
    );
    const schedule = parseSchedule(scheduleAnswer);
    log.info(
      `    cron "${schedule.cron}" (UTC)${schedule.note !== undefined ? ` = ${schedule.note}` : ""}`,
    );

    const labelsAnswer = await prompter.ask(
      "  Labels that mark an issue for fixowl (comma-separated)",
      {
        default: lastLabels,
        validate: (value) =>
          parseLabels(value).length > 0 ? undefined : "at least one label is required",
      },
    );
    const maxIssuesAnswer = await prompter.ask("  Max issues per night", {
      default: lastMaxIssues,
      validate: (value) => (/^[1-9]\d*$/.test(value) ? undefined : "enter a positive whole number"),
    });

    const modelSelection = await stepModelSelection(prompter, agent);

    repos.push({
      name,
      schedule: schedule.cron,
      scheduleNote: schedule.note,
      labels: parseLabels(labelsAnswer),
      maxIssuesPerRun: Number(maxIssuesAnswer),
      ...modelSelection,
    });
    lastSchedule = scheduleAnswer;
    lastLabels = labelsAnswer;
    lastMaxIssues = maxIssuesAnswer;

    if (!(await prompter.confirm("\nAdd another repo?", false))) return repos;
  }
}

async function askRepoName(
  prompter: Prompter,
  admin: Octokit,
  chosen: readonly RepoAnswers[],
): Promise<string> {
  for (;;) {
    const name = await prompter.ask("  Repository (owner/repo)", {
      validate: (value) => {
        if (!repoFullNameSchema.safeParse(value).success) return "expected owner/repo";
        if (chosen.some((repo) => repo.name === value)) return "that repo is already on the list";
        return undefined;
      },
    });
    const [owner = "", repo = ""] = name.split("/");
    try {
      const { data } = await admin.rest.repos.get({ owner, repo });
      log.ok(
        `${name} reachable (${data.private ? "private" : "public"}, default branch ${data.default_branch})`,
      );
      return name;
    } catch (error) {
      log.warn(`cannot reach ${name}: ${describeGitHubError(error)}`);
      log.info(
        `  A fine-grained PAT only sees the repos it was granted. Add ${name} to the\n` +
          `  admin token's repository list at ${PAT_URL}, or check the spelling.`,
      );
      if (!(await prompter.confirm("  Try a different repo name?", true))) return name;
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3b: model + reasoning effort for the coding agent
// ---------------------------------------------------------------------------

interface ModelSelectionAnswers {
  defaultModel?: string;
  defaultEffort?: string;
  labelModels?: Record<string, { model: string; effort: string }>;
}

/**
 * Presents the agent's available models/efforts and captures either a per-label
 * mapping (comma-separated label names, one model+effort each) or a single
 * default, or neither (fall through to the agent CLI's own default).
 */
async function stepModelSelection(
  prompter: Prompter,
  agent: string,
): Promise<ModelSelectionAnswers> {
  const catalog = agentCatalogEntry(agent);
  if (catalog === undefined) return {}; // agent has no model/effort axis; nothing to ask

  log.info(`
  Model selection for "${agent}"
  Available models:`);
  for (const model of catalog.models) {
    log.info(`    ${model.id} - ${model.description}`);
  }
  log.info(`  Available reasoning efforts: ${catalog.efforts.join(", ")}`);

  const answers: ModelSelectionAnswers = {};

  const wantsLabels = await prompter.confirm(
    "\n  Map specific labels to a model + effort (heavy issues get a bigger model)?",
    false,
  );
  if (wantsLabels) {
    const labelsAnswer = await prompter.ask(
      "  Selector label names (comma-separated; one model+effort each)",
      {
        validate: (value) =>
          parseLabels(value).length > 0 ? undefined : "enter at least one label",
      },
    );
    const labelModels: Record<string, { model: string; effort: string }> = {};
    for (const label of parseLabels(labelsAnswer)) {
      const model = await chooseModel(prompter, catalog, `  Model for "${label}"`);
      const effort = await chooseEffort(prompter, catalog, `  Effort for "${label}"`);
      labelModels[label] = { model, effort };
    }
    answers.labelModels = labelModels;
  }

  const setDefault = await prompter.confirm(
    wantsLabels
      ? "\n  Set a default model + effort for issues carrying none of those labels?"
      : "\n  Set a default model + effort for this repo (No = use the agent's own default)?",
    !wantsLabels,
  );
  if (setDefault) {
    answers.defaultModel = await chooseModel(prompter, catalog, "  Default model");
    answers.defaultEffort = await chooseEffort(prompter, catalog, "  Default effort");
  }

  return answers;
}

async function chooseModel(
  prompter: Prompter,
  catalog: AgentCatalogEntry,
  question: string,
): Promise<string> {
  return await prompter.choose(
    question,
    catalog.models.map((model) => ({ value: model.id, label: model.id, hint: model.description })),
  );
}

async function chooseEffort(
  prompter: Prompter,
  catalog: AgentCatalogEntry,
  question: string,
): Promise<string> {
  return await prompter.choose(
    question,
    catalog.efforts.map((effort) => ({ value: effort, label: effort })),
  );
}

// ---------------------------------------------------------------------------
// Step 4: validate, provision, and optionally start
// ---------------------------------------------------------------------------

async function validateAndProvision(prompter: Prompter, configPath: string): Promise<void> {
  log.info(`
Step 4/4  Validate and provision
--------------------------------`);

  log.info("\n$ fixowl validate");
  let ctx;
  try {
    ctx = makeContext(configPath === CONFIG_PATH ? undefined : configPath);
  } catch (error) {
    // A hand-edited config that no longer parses; the wizard's own output always does.
    log.error(`${configPath} could not be read: ${describeError(error)}`);
    log.info('\nFix that file, or re-run `fixowl init` and choose "Start over".');
    process.exitCode = 1;
    return;
  }
  if (!(await validateCommand(ctx))) {
    log.info(`
Your answers are saved in ${configPath}, so nothing is lost. Fix the problems
listed above (edit that file or re-run \`fixowl init\`), then continue with:

  fixowl validate && fixowl provision && fixowl start`);
    process.exitCode = 1;
    return;
  }

  log.info("\n$ fixowl provision");
  try {
    await provisionCommand(ctx, undefined, {});
  } catch (error) {
    log.error(describeError(error));
    log.info(`
Provisioning stopped. The usual causes are an admin token missing a permission
(Administration, Secrets, Contents, Workflows, Issues or Actions, all read and
write) or a repo it was never granted. Fix that and re-run:

  fixowl provision`);
    process.exitCode = 1;
    return;
  }

  log.info("");
  log.ok("provisioned");
  if (await prompter.confirm("\nStart the runner service now?", true)) {
    log.info("\n$ fixowl start");
    try {
      await startCommand(ctx, undefined);
    } catch (error) {
      log.error(describeError(error));
      log.info("\nThe runner did not start. Fix the problem above and re-run: fixowl start");
      process.exitCode = 1;
      return;
    }
  } else {
    log.info("\nSkipped. Start it whenever you like with: fixowl start");
  }

  log.info(`
🦉 fixowl is set up.

  File an issue, add the label you chose, and check back tomorrow.
  fixowl status              # runner, last run, open fixowl PRs
  fixowl run owner/repo      # do not wait for the cron; run a night now
  fixowl logs owner/repo     # what happened last night`);
}

// ---------------------------------------------------------------------------
// Non-interactive fallback: scaffold the files and print the manual steps.
// ---------------------------------------------------------------------------

const STARTER_CONFIG = `# fixowl configuration. Secrets live in secrets.env next to this file and are
# referenced as \${VAR}; this file never contains raw secrets.
version: 1

github:
  admin_token: \${FIXOWL_ADMIN_TOKEN}      # fine-grained PAT, CLI machine only
  runtime_token: \${FIXOWL_RUNTIME_TOKEN}  # fine-grained PAT, pushed to repos as an Actions secret

# runner:
#   dir: ~/.fixowl/runners   # must live under $HOME (Colima shares $HOME with its VM)

defaults:
  schedule: "37 1 * * *"     # UTC; odd minute dodges GitHub's peak-time cron delays
  labels: { any: [overnight] }
  agent: claude
  max_issues_per_run: 4
  issue_timeout_minutes: 45
  # model: sonnet            # default model when an issue has no selector label
  # effort: medium           # default reasoning effort (low, medium, high, xhigh, max)

# Per-agent env allowlist: the ONLY env vars entering per-issue containers.
agents:
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] }

repos:
  - name: your-user/your-repo
    # schedule: "30 1 * * *"   # per-repo override
    # model: opus              # per-repo default model override
    # label_models:            # dedicated selector labels; exactly one per issue
    #   heavy: { model: opus, effort: max }
    #   quick: { model: haiku, effort: low }
`;

const STARTER_SECRETS = `# chmod 600. Values referenced from config.yaml as \${VAR}, and agent env vars
# provisioned into repos as Actions secrets are read from here too.
FIXOWL_ADMIN_TOKEN=
FIXOWL_RUNTIME_TOKEN=
CLAUDE_CODE_OAUTH_TOKEN=
`;

function scaffoldOnly(configPath: string, secretsPath: string): void {
  if (existsSync(configPath)) {
    log.info(`${configPath} already exists; leaving it alone`);
  } else {
    writeFileSync(configPath, STARTER_CONFIG);
    log.ok(`wrote ${configPath}`);
  }
  if (existsSync(secretsPath)) {
    log.info(`${secretsPath} already exists; leaving it alone`);
  } else {
    writeFileSync(secretsPath, STARTER_SECRETS, { mode: 0o600 });
    log.ok(`wrote ${secretsPath} (mode 600)`);
  }
  chmodSync(secretsPath, 0o600);

  log.info(`
Next steps (or re-run \`fixowl init\` on a terminal for the guided setup):
  1. Mint two fine-grained PATs at ${PAT_URL}, scoped to ONLY your target repos:
       admin   - Administration RW, Secrets RW, Contents RW, Workflows RW, Issues RW,
                 Actions RW (stays on this machine)
       runtime - Contents RW, Pull requests RW, Issues RW (becomes a repo Actions secret)
     Put them in ${secretsPath}.
  2. If using the claude agent: run \`claude setup-token\` and put the resulting
     token in ${secretsPath} as CLAUDE_CODE_OAUTH_TOKEN.
  3. Edit ${configPath}: list your repos.
  4. Run \`fixowl validate\`, then \`fixowl provision\` and \`fixowl start\`.`);
}

// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a validator that signals problems by throwing, for prompt validation. */
function problemWith(check: () => unknown): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    return describeError(error);
  }
}
