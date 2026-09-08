import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Octokit } from "@octokit/rest";
import {
  agentCatalogEntry,
  FIXOWL_DEFAULTS,
  getAgentAdapter,
  repoFullNameSchema,
  type AgentCatalogEntry,
} from "@fixowl/core";
import { CONFIG_PATH, loadSecrets, SECRETS_PATH } from "../config-load.ts";
import { makeContext } from "../context.ts";
import { checkDockerEngine, type EngineStatus } from "../docker/engine-check.ts";
import { resolvePrivateKey, toPkcs8Pem } from "../github/app-key.ts";
import { appClient, githubClient } from "../github/client.ts";
import { describeGitHubError } from "../github/errors.ts";
import {
  parseLabels,
  parseSchedule,
  renderConfigYaml,
  renderSecretsEnv,
  type RepoAnswers,
  type RuntimeCredentialAnswer,
} from "../init/config-file.ts";
import { log } from "../log.ts";
import { createPrompter, maskSecret, type Prompter } from "../prompt.ts";
import { fallbackInstallCommand } from "./fallback.ts";
import { provisionCommand } from "./provision.ts";
import { startCommand } from "./start.ts";
import { validateCommand } from "./validate.ts";

const PAT_URL = "https://github.com/settings/personal-access-tokens/new";
const APP_URL = "https://github.com/settings/apps/new";

/** The App's repository permissions, shared by the App-setup step and help text. */
const APP_PERMISSIONS = [
  "Contents: Read and write",
  "Pull requests: Read and write",
  "Issues: Read and write",
  "Checks: Read-only",
  "Commit statuses: Read-only",
  "Actions: Read-only",
  "Administration: Read-only",
] as const;

/** Renders APP_PERMISSIONS as one bullet per line, each prefixed with `indent`. */
function appPermissionsBullets(indent: string): string {
  return APP_PERMISSIONS.map((permission) => `${indent}- ${permission}`).join("\n");
}

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
  /** Engine probe, injectable for tests; defaults to the real detector. */
  checkEngine?: () => Promise<EngineStatus>;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  const configPath = options.configPath ?? CONFIG_PATH;
  const secretsPath =
    options.configPath !== undefined ? join(dirname(configPath), "secrets.env") : SECRETS_PATH;
  const checkEngine = options.checkEngine ?? checkDockerEngine;
  mkdirSync(dirname(configPath), { recursive: true });

  if (options.nonInteractive === true || process.stdin.isTTY !== true) {
    scaffoldOnly(configPath, secretsPath);
    await reportEngineStatus(checkEngine);
    return;
  }

  const prompter = createPrompter();
  try {
    await runWizard(prompter, configPath, secretsPath, checkEngine);
  } finally {
    prompter.close();
  }
}

/**
 * Runs the container-engine probe and reports it, NON-FATALLY: init's job is to
 * write config, and the user may install an engine afterward. A missing engine
 * is a warning that points at `fixowl start` and `fixowl validate`, never a
 * hard failure. Detection is reused from `checkDockerEngine`, not duplicated.
 */
async function reportEngineStatus(checkEngine: () => Promise<EngineStatus>): Promise<void> {
  const engine = await checkEngine();
  if (engine.ok) {
    log.ok(`container engine ready: ${engine.detail}`);
    return;
  }
  log.warn(
    `${engine.detail}\n` +
      "  fixowl can finish setting up, but `fixowl start` needs a container engine.\n" +
      "  Install one, then re-check with `fixowl validate`.",
  );
}

async function runWizard(
  prompter: Prompter,
  configPath: string,
  secretsPath: string,
  checkEngine: () => Promise<EngineStatus>,
): Promise<void> {
  log.info(`
🦉 fixowl setup

This walks you through the whole thing: GitHub tokens, the coding agent, the
repos to watch, then validates and provisions them. Nothing is written until
the questions are answered, and every answer is stored in ${dirname(configPath)}.`);

  await reportEngineStatus(checkEngine);

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
  const { admin, runtimeCredential } = await stepTokens(prompter, secrets);
  const { agent, agentEnv } = await stepAgent(prompter, secrets);
  const repos = await stepRepos(prompter, admin, agent);
  const wantFallback = await stepFallback(prompter, secrets);

  writeFileSync(
    configPath,
    renderConfigYaml({ agent, agentEnv, repos, runtimeCredential, fallback: wantFallback }),
  );
  log.ok(`wrote ${configPath}`);
  writeFileSync(secretsPath, renderSecretsEnv(secrets), { mode: 0o600 });
  chmodSync(secretsPath, 0o600);
  log.ok(`wrote ${secretsPath} (mode 600)`);

  await validateAndProvision(prompter, configPath, { installFallback: wantFallback });
}

// ---------------------------------------------------------------------------
// Optional step: the local fallback trigger and its scoped token
// ---------------------------------------------------------------------------

/**
 * Opt-in setup of the local fallback trigger. Collects its own least-privilege
 * token (Actions: write only), kept separate from the admin and runtime tokens
 * so the admin token stays revocable. Returns whether the fallback was enabled.
 */
async function stepFallback(prompter: Prompter, secrets: Record<string, string>): Promise<boolean> {
  log.info(`
Local fallback trigger (optional)
---------------------------------
GitHub's scheduled cron is best-effort and can silently skip a night. The
fallback is a small job on THIS host that runs shortly after the cron and
dispatches the night run only if the cron did not fire - a self-healing backup.
A fallback run is recorded as workflow_dispatch (a real cron run is schedule),
so you can still tell whether the cron itself is working. It is opt-in, and
macOS-only for now (launchd).`);
  if (!(await prompter.confirm("\nSet up the local fallback trigger now?", false))) {
    log.info("Skipped. You can enable it any time with: fixowl fallback install");
    return false;
  }

  log.info(`
Dispatching the workflow needs a token with Actions: write, which the admin and
runtime tokens deliberately do not provide for routine use. Mint a THIRD
fine-grained PAT, scoped to ONLY your target repos, granting exactly:

  Actions: Read and write   (nothing else)

Keeping it separate means the fallback holds only Actions: write, so you can
still revoke or downgrade the admin token after provisioning.
Mint it at ${PAT_URL}`);
  await prompter.pause("\nPress Enter once you have the fallback token ready ");
  secrets.FIXOWL_FALLBACK_TOKEN = await askToken(prompter, {
    label: "  fallback token",
    existing: secrets.FIXOWL_FALLBACK_TOKEN,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Step 1: the admin token and the runtime credential (PAT or GitHub App)
// ---------------------------------------------------------------------------

async function stepTokens(
  prompter: Prompter,
  secrets: Record<string, string>,
): Promise<{ admin: Octokit; runtimeCredential: RuntimeCredentialAnswer }> {
  log.info(`
Step 1/4  GitHub credentials
----------------------------
fixowl needs an admin token (this machine only, setup-only) plus ONE runtime
credential the night run pushes and calls the API with. Both are scoped to ONLY
the repos you want fixowl to touch.

  admin    fine-grained PAT with:
             - Administration: Read and write
             - Secrets: Read and write
             - Contents: Read and write
             - Workflows: Read and write
             - Issues: Read and write
             - Actions: Read and write
             - Pull requests: Read and write
           Setup-only: once \`fixowl provision\` has run you can REVOKE it (or
           downgrade it to read-only if you want \`fixowl status\` to confirm
           the runner is online). Routine \`fixowl start\` needs no admin token.

Runtime credential - you pick a tier next:
  Tier 1  fine-grained PAT: fastest to set up. But GitHub exposes no grantable
          "Checks" scope to PATs, so the CI-gated fix loop cannot read check-run
          status and DEGRADES (it opens the PR after a settle instead of
          verifying CI).
  Tier 2  GitHub App: ~15 min once. The installation token reads Checks, so the
          CI gate is REAL (green flips a PR to ready; red keeps it a draft), and
          @octokit/auth-app auto-refreshes the token across the whole night, so
          it never hits the 1-hour installation-token expiry cliff.

Mint the admin PAT at ${PAT_URL}`);
  await prompter.pause("\nPress Enter once you have the admin token ready ");

  const adminToken = await askToken(prompter, {
    label: "  admin token",
    existing: secrets.FIXOWL_ADMIN_TOKEN,
  });
  secrets.FIXOWL_ADMIN_TOKEN = adminToken;
  const runtimeCredential = await stepRuntimeCredential(prompter, secrets);
  return { admin: githubClient(adminToken), runtimeCredential };
}

/** Pick the runtime-credential tier and collect it: a PAT, or a GitHub App. */
async function stepRuntimeCredential(
  prompter: Prompter,
  secrets: Record<string, string>,
): Promise<RuntimeCredentialAnswer> {
  const tier = await prompter.choose("\nRuntime credential tier?", [
    {
      value: "pat",
      label: "Tier 1: fine-grained PAT",
      hint: "fastest; the CI gate degrades (a PAT cannot read checks)",
    },
    {
      value: "app",
      label: "Tier 2: GitHub App",
      hint: "~15 min once; real CI-gating, auto-refreshing token",
    },
  ]);
  if (tier === "pat") {
    log.info(`
The runtime PAT is scoped to ONLY your target repos, with:
  - Contents: Read and write
  - Pull requests: Read and write
  - Issues: Read and write
  - Commit statuses: Read-only
  - Actions: Read-only
  - Administration: Read-only
It becomes a repo Actions secret the night run pushes and opens PRs with.
Mint it at ${PAT_URL}`);
    await prompter.pause("\nPress Enter once you have the runtime token ready ");
    secrets.FIXOWL_RUNTIME_TOKEN = await askToken(prompter, {
      label: "  runtime token",
      existing: secrets.FIXOWL_RUNTIME_TOKEN,
    });
    return { kind: "pat" };
  }
  return await stepAppCredential(prompter, secrets);
}

/**
 * Collect and verify the GitHub App credential. The private key is stored
 * base64-encoded (so the multi-line PEM survives secrets.env); verification
 * confirms the App authenticates and holds Checks: read - the honest pre-flight
 * for the whole reason to use an App - plus the write permissions the night
 * needs (Contents: write for pushes, Pull requests: write for PRs).
 */
async function stepAppCredential(
  prompter: Prompter,
  secrets: Record<string, string>,
): Promise<RuntimeCredentialAnswer> {
  log.info(`
GitHub App setup
----------------
1. Create the App at ${APP_URL}
   Fill in the form:
   - GitHub App name: any unique name, e.g. fixowl-<your-username> (must be
     unique across all of GitHub).
   - Homepage URL (required by GitHub, not used functionally): any valid URL
     works - your target repo's URL or your GitHub profile URL are fine.
   - Description, Callback URL / Setup URL, "Request user authorization
     (OAuth) during installation": leave blank / unchecked.
   - Webhook: UNCHECK "Active" (no webhook needed; leave URL and secret blank).
   - Repository permissions - set exactly:
${appPermissionsBullets("     ")}
     (leave every other permission at "No access")
   - Account permissions / Subscribe to events: none.
   - "Where can this GitHub App be installed?": "Only on this account" is
     fine for personal use.
   - Click "Create GitHub App".
2. Install the App on your target repo(s) - a SEPARATE step, in the App's
   own settings, not the repo settings:
   - Go to https://github.com/settings/apps -> click your App.
   - In the left sidebar, click "Install App".
   - Click the green "Install" button next to your account.
   - Choose "Only select repositories" -> pick your target repo(s) -> Install.
   - Note: https://github.com/settings/installations looks empty until you
     do this - that is expected.
3. Generate a private key: on your App's settings page
   (https://github.com/settings/apps/<your-app-name>), scroll down to
   "Private keys" and click "Generate a private key", then download the .pem.
4. base64-encode it so it survives secrets.env, on ONE line:
     base64 -i app.private-key.pem | tr -d '\\n'
   App ID: on your App's settings page
   (https://github.com/settings/apps/<your-app-name>), near the top in the
   "About" section. Installation ID is the number in the install URL:
   https://github.com/settings/installations/<id>. See docs/app-auth.md.`);
  for (;;) {
    const appId = await prompter.ask("  App ID (numeric)", { validate: numericId });
    const installationId = await prompter.ask("  Installation ID (numeric)", {
      validate: numericId,
    });
    const privateKeyB64 = await prompter.secret("  App private key (base64 of the .pem)", {
      existing: secrets.FIXOWL_APP_PRIVATE_KEY,
      validate: (value) =>
        /\s/.test(value.trim())
          ? "paste the base64 on one line (base64 -i app.pem | tr -d '\\n')"
          : undefined,
    });
    const check = await verifyApp(appId, installationId, privateKeyB64);
    if (check.ok) {
      secrets.FIXOWL_APP_PRIVATE_KEY = privateKeyB64;
      log.ok(check.message);
      return { kind: "app", appId, installationId };
    }
    log.warn(check.message);
    if (!(await prompter.confirm("  Enter the App details again?", true))) {
      // Keep what was typed; `fixowl validate` re-checks before provisioning.
      secrets.FIXOWL_APP_PRIVATE_KEY = privateKeyB64;
      return { kind: "app", appId, installationId };
    }
  }
}

/** True-returning validator for a numeric id prompt. */
function numericId(value: string): string | undefined {
  return /^\d+$/.test(value.trim()) ? undefined : "enter the numeric id";
}

/**
 * Confirm a GitHub App credential authenticates and holds Checks: read (plus the
 * Contents: write / Pull requests: write the night needs). Mirrors
 * `fixowl validate`'s App branch so the wizard fails fast instead of at 2am.
 */
async function verifyApp(
  appId: string,
  installationId: string,
  privateKeyB64: string,
): Promise<{ ok: boolean; message: string }> {
  let client;
  let cred;
  try {
    cred = {
      kind: "app" as const,
      appId: Number(appId),
      installationId: Number(installationId),
      privateKey: toPkcs8Pem(resolvePrivateKey(privateKeyB64)),
    };
    client = appClient(cred);
  } catch (error) {
    return { ok: false, message: `App private key unreadable: ${describeError(error)}` };
  }
  let slug: string;
  try {
    const { data } = await client.rest.apps.getAuthenticated();
    slug = data?.slug ?? "?";
  } catch (error) {
    return {
      ok: false,
      message: `GitHub rejected the App credentials: ${describeGitHubError(error)}`,
    };
  }
  try {
    const { data: install } = await client.rest.apps.getInstallation({
      installation_id: cred.installationId,
    });
    const checks = install.permissions?.checks;
    if (checks !== "read" && checks !== "write") {
      return {
        ok: false,
        message: `App "${slug}" authenticated, but it is missing Checks: read - the CI gate would degrade. Grant Checks: read and retry.`,
      };
    }
    if (install.permissions?.contents !== "write") {
      return {
        ok: false,
        message: `App "${slug}" authenticated, but it is missing Contents: write - pushes will fail at night. Grant Contents: write and retry.`,
      };
    }
    if (install.permissions?.pull_requests !== "write") {
      return {
        ok: false,
        message: `App "${slug}" authenticated, but it is missing Pull requests: write - opening PRs will fail at night. Grant Pull requests: write and retry.`,
      };
    }
    return {
      ok: true,
      message: `App "${slug}" authenticated; installation ${cred.installationId} has Checks: ${checks}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `App "${slug}" authenticated, but installation ${installationId} is not reachable: ${describeGitHubError(error)}`,
    };
  }
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
issue as fixowl's, the run budgets that stop the night (usage %, wall-clock,
and an optional issue-count cap), the per-issue timeout, and which model the
coding agent runs with.`);

  const repos: RepoAnswers[] = [];
  let lastSchedule = "02:37";
  let lastLabels = "overnight";
  let lastMaxIssues = "4";
  let lastUsageBudget = String(FIXOWL_DEFAULTS.usageBudgetPercent);
  let lastRunBudget = String(FIXOWL_DEFAULTS.runBudgetMinutes);
  let lastIssueTimeout = String(FIXOWL_DEFAULTS.issueTimeoutMinutes);

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
    // Layered run-budget (issue #21): the night stops on the first condition
    // that trips. Each is optional; a blank answer opts that axis out.
    const usageBudgetAnswer = await prompter.ask(
      "  Usage budget - stop the night at what % of the agent's usage window? (blank = no usage cap)",
      {
        default: lastUsageBudget,
        validate: (value) =>
          value.trim() === "" || isPercent(value)
            ? undefined
            : "enter a percent 0-100, or leave blank for no usage cap",
      },
    );
    const runBudgetAnswer = await prompter.ask(
      "  Graceful run budget - don't start a new issue after how many minutes? (blank = none)",
      {
        default: lastRunBudget,
        validate: (value) =>
          value.trim() === "" || /^[1-9]\d*$/.test(value.trim())
            ? undefined
            : "enter a positive whole number of minutes, or leave blank",
      },
    );
    const maxIssuesAnswer = await prompter.ask(
      "  Optional hard cap - max issues per night (secondary count cap)",
      {
        default: lastMaxIssues,
        validate: (value) =>
          /^[1-9]\d*$/.test(value) ? undefined : "enter a positive whole number",
      },
    );
    const issueTimeoutAnswer = await prompter.ask(
      "  Per-issue timeout in minutes (a stuck agent is killed after this)",
      {
        default: lastIssueTimeout,
        validate: (value) =>
          /^[1-9]\d*$/.test(value) ? undefined : "enter a positive whole number",
      },
    );

    const labels = parseLabels(labelsAnswer);
    const modelSelection = await stepModelSelection(
      prompter,
      agent,
      await fetchLabelCandidates(admin, name, labels),
    );

    repos.push({
      name,
      schedule: schedule.cron,
      scheduleNote: schedule.note,
      labels,
      maxIssuesPerRun: Number(maxIssuesAnswer),
      usageBudgetPercent: usageBudgetAnswer.trim() === "" ? undefined : Number(usageBudgetAnswer),
      runBudgetMinutes: runBudgetAnswer.trim() === "" ? undefined : Number(runBudgetAnswer),
      issueTimeoutMinutes: Number(issueTimeoutAnswer),
      ...modelSelection,
    });
    lastSchedule = scheduleAnswer;
    lastLabels = labelsAnswer;
    lastMaxIssues = maxIssuesAnswer;
    lastUsageBudget = usageBudgetAnswer;
    lastRunBudget = runBudgetAnswer;
    lastIssueTimeout = issueTimeoutAnswer;

    if (!(await prompter.confirm("\nAdd another repo?", false))) return repos;
  }
}

/** True when the answer is a number in 0..100 (the usage-budget percent range). */
function isPercent(value: string): boolean {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
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

/** A selector-label candidate: one of the repo's labels, or "let me type them". */
type LabelPick = { kind: "label"; name: string } | { kind: "other" };

/**
 * Captures either a per-label mapping (one model+effort per selector label) or
 * a single default, or neither (fall through to the agent CLI's own default).
 * Every list here is arrow-key driven and sourced from the agent catalog, so an
 * agent with no model/effort axis asks nothing at all.
 */
async function stepModelSelection(
  prompter: Prompter,
  agent: string,
  labelCandidates: readonly string[],
): Promise<ModelSelectionAnswers> {
  const catalog = agentCatalogEntry(agent);
  if (catalog === undefined) return {}; // agent has no model/effort axis; nothing to ask

  log.info(`
  Model selection for "${agent}" (${catalog.models.length} models, efforts: ${catalog.efforts.join(", ")})`);

  const answers: ModelSelectionAnswers = {};

  const wantsLabels = await prompter.confirm(
    "\n  Map specific labels to a model + effort (heavy issues get a bigger model)?",
    false,
  );
  if (wantsLabels) {
    const labelModels: Record<string, { model: string; effort: string }> = {};
    for (const label of await chooseSelectorLabels(prompter, labelCandidates)) {
      const model = await chooseModel(prompter, catalog, `  Model for "${label}"`);
      const effort = await chooseEffort(prompter, catalog, `  Effort for "${label}"`);
      labelModels[label] = { model, effort };
    }
    if (Object.keys(labelModels).length > 0) answers.labelModels = labelModels;
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

/**
 * Which labels get their own model+effort: ticked off the repo's existing
 * labels, with an "other" row for labels that do not exist yet (and the plain
 * typed prompt when the repo's labels could not be listed).
 */
async function chooseSelectorLabels(
  prompter: Prompter,
  candidates: readonly string[],
): Promise<string[]> {
  if (candidates.length === 0) return await askSelectorLabelNames(prompter);

  const picks = await prompter.multiChoose<LabelPick>(
    "\n  Which labels pick a model + effort?",
    [
      ...candidates.map((name) => ({ value: { kind: "label" as const, name }, label: name })),
      { value: { kind: "other" }, label: "Other…", hint: "type label names yourself" },
    ],
    { min: 1 },
  );

  const chosen = picks.flatMap((pick) => (pick.kind === "label" ? [pick.name] : []));
  if (!picks.some((pick) => pick.kind === "other")) return chosen;
  return [...new Set([...chosen, ...(await askSelectorLabelNames(prompter))])];
}

async function askSelectorLabelNames(prompter: Prompter): Promise<string[]> {
  const answer = await prompter.ask(
    "  Selector label names (comma-separated; one model+effort each)",
    {
      validate: (value) => (parseLabels(value).length > 0 ? undefined : "enter at least one label"),
    },
  );
  return parseLabels(answer);
}

/**
 * The repo's existing labels, minus the ones that already mark issues for
 * fixowl, offered as selector-label candidates. Read-only and best-effort: an
 * unreachable repo just means the wizard asks for names to be typed instead.
 */
async function fetchLabelCandidates(
  admin: Octokit,
  name: string,
  exclude: readonly string[],
): Promise<string[]> {
  const [owner = "", repo = ""] = name.split("/");
  try {
    const { data } = await admin.rest.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
    return data.map((label) => label.name).filter((label) => !exclude.includes(label));
  } catch {
    return [];
  }
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

async function validateAndProvision(
  prompter: Prompter,
  configPath: string,
  options: { installFallback?: boolean } = {},
): Promise<void> {
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
(all read and write) or a repo it was never granted:
  - Administration
  - Secrets
  - Contents
  - Workflows
  - Issues
  - Actions
  - Pull requests
Fix that and re-run:

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

  if (options.installFallback === true) {
    log.info("\n$ fixowl fallback install");
    if (process.platform !== "darwin") {
      log.warn(
        "the local fallback is macOS-only for now; on Linux add a cron/systemd-timer\n" +
          "  that runs `fixowl fallback check` shortly after your cron.",
      );
    } else {
      try {
        await fallbackInstallCommand(
          ctx,
          undefined,
          configPath === CONFIG_PATH ? undefined : configPath,
        );
      } catch (error) {
        log.error(describeError(error));
        log.info(
          "\nThe fallback did not install. Fix the problem above and re-run: fixowl fallback install",
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  log.info(`
🦉 fixowl is set up.

  Merge the fixowl workflow PR (branch fixowl/provision-workflow) first -
  scheduled runs do not activate until the workflow is on the default branch.

  Then file an issue, add the label you chose, and check back tomorrow.
  fixowl status              # runner, last run, open fixowl PRs
  fixowl run owner/repo      # do not wait for the cron; run a night now
  fixowl logs owner/repo     # what happened last night${
    options.installFallback === true
      ? "\n  fixowl fallback status     # local cron-backup: installed? next fire?"
      : ""
  }`);
}

// ---------------------------------------------------------------------------
// Non-interactive fallback: scaffold the files and print the manual steps.
// ---------------------------------------------------------------------------

const STARTER_CONFIG = `# fixowl configuration. Secrets live in secrets.env next to this file and are
# referenced as \${VAR}; this file never contains raw secrets.
version: 1

github:
  admin_token: \${FIXOWL_ADMIN_TOKEN}      # fine-grained PAT, CLI machine only; setup-only, revocable after provision
  # --- runtime credential: choose ONE of the two tiers below ---
  runtime_token: \${FIXOWL_RUNTIME_TOKEN}  # Tier 1: fine-grained PAT (fast to try; CI gate degrades - a PAT cannot read checks)
  # app:                                     # Tier 2: GitHub App (real CI-gating; auto-refreshing token). See docs/app-auth.md.
  #   app_id: 123456
  #   installation_id: 7890123
  #   private_key: \${FIXOWL_APP_PRIVATE_KEY} # base64 of the downloaded App .pem (normalized to PKCS#8 at provision)
  # fallback_token: \${FIXOWL_FALLBACK_TOKEN}  # optional; fine-grained PAT, Actions: write only, for the local fallback

# runner:
#   dir: ~/.fixowl/runners   # must live under $HOME (Colima shares $HOME with its VM)

# fallback:
#   gap_minutes: 30          # minutes after the cron the local fallback fires (default 30)

defaults:
  schedule: "37 1 * * *"     # UTC; odd minute dodges GitHub's peak-time cron delays
  labels: { any: [overnight] }
  agent: claude
  # Layered run-budget (issue #21): the night stops on the first condition that
  # trips. Each is optional; delete/omit a line to opt that axis out.
  max_issues_per_run: 4        # secondary cap: at most this many PRs ship
  # usage_budget_percent: 85   # stop before a new issue once the usage window hits this %
  # run_budget_minutes: 240    # graceful wall-clock: don't start a new issue after this long
  issue_timeout_minutes: 45    # per-issue hard timeout (a stuck agent is killed)
  ci_max_tries: 3            # CI-gated fix loop: agent passes before a draft PR is left
  ci_timeout_minutes: 60     # minutes each pass waits for the base branch's required checks
  # model: sonnet            # default model when an issue has no selector label
  # effort: medium           # default reasoning effort (low, medium, high, xhigh, max)

# Per-agent env allowlist: the ONLY env vars entering per-issue containers.
agents:
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] }

repos:
  - name: your-user/your-repo
    # schedule: "30 1 * * *"   # per-repo override
    # ci_max_tries: 5          # per-repo CI-gated-loop override
    # ci_timeout_minutes: 90   # per-repo override
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
# --- Tier 2 (GitHub App) alternative to FIXOWL_RUNTIME_TOKEN; see docs/app-auth.md ---
# FIXOWL_APP_PRIVATE_KEY=   # base64 of the downloaded App .pem (base64 -i app.pem | tr -d '\\n')
# FIXOWL_FALLBACK_TOKEN=   # optional; fine-grained PAT, Actions: write only (see docs/local-fallback.md)
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
  1. Mint the admin fine-grained PAT at ${PAT_URL}, scoped to ONLY your target repos:
       admin - stays on this machine; used only to provision and register the
               runner (revoke or downgrade to read-only afterward):
         - Administration: Read and write
         - Secrets: Read and write
         - Contents: Read and write
         - Workflows: Read and write
         - Issues: Read and write
         - Actions: Read and write
         - Pull requests: Read and write
     Then choose ONE runtime credential and put it in ${secretsPath}:
       Tier 1 (runtime PAT, quick start) - mint it at ${PAT_URL} with:
         - Contents: Read and write
         - Pull requests: Read and write
         - Issues: Read and write
         - Commit statuses: Read-only
         - Actions: Read-only
         - Administration: Read-only
         Becomes a repo Actions secret; GitHub exposes no grantable "Checks"
         scope for fine-grained PATs, so the CI gate DEGRADES when check-run
         status is unreadable. Keep runtime_token in the config.
       Tier 2 (GitHub App, real CI-gating):
         a. Create the App at ${APP_URL}
            - GitHub App name: any unique name, e.g. fixowl-<your-username>.
            - Homepage URL (required by GitHub, not used functionally): any
              valid URL works - your target repo's URL or your profile URL.
            - Description, Callback URL / Setup URL, "Request user
              authorization (OAuth) during installation": leave blank/unchecked.
            - Webhook: UNCHECK "Active".
            - Repository permissions - set exactly:
${appPermissionsBullets("              ")}
              (leave every other permission at "No access")
            - "Where can this GitHub App be installed?": "Only on this
              account" is fine for personal use.
            - Click "Create GitHub App".
         b. Install it (a SEPARATE step, in the App's own settings):
            go to https://github.com/settings/apps -> click your App ->
            "Install App" (left sidebar) -> green "Install" next to your
            account -> "Only select repositories" -> pick your repo(s) ->
            Install. (https://github.com/settings/installations looks empty
            until you do this - that is expected.)
         c. Generate a private key: on your App's settings page
            (https://github.com/settings/apps/<your-app-name>), scroll down
            to "Private keys" and click "Generate a private key", then
            download the .pem and base64-encode it onto one line:
              base64 -i app.private-key.pem | tr -d '\\n'
            and put it in ${secretsPath} as FIXOWL_APP_PRIVATE_KEY. App ID:
            on your App's settings page
            (https://github.com/settings/apps/<your-app-name>), near the top
            in the "About" section. Installation ID is the number in the
            install URL: https://github.com/settings/installations/<id>.
         d. Uncomment the github.app block in the config. The installation
            token auto-refreshes across the night. See docs/app-auth.md.
  2. If using the claude agent: run \`claude setup-token\` and put the resulting
     token in ${secretsPath} as CLAUDE_CODE_OAUTH_TOKEN.
  3. Edit ${configPath}: list your repos.
  4. Run \`fixowl validate\`, then \`fixowl provision\` and \`fixowl start\`.
  5. Optional: to back up GitHub's flaky cron, mint a THIRD fine-grained PAT with
     ONLY Actions: write on your repos, put it in ${secretsPath} as
     FIXOWL_FALLBACK_TOKEN, uncomment github.fallback_token in the config, then
     run \`fixowl fallback install\` (macOS). See docs/local-fallback.md.`);
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
