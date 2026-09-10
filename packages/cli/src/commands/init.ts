import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Octokit } from "@octokit/rest";
import {
  agentBilling,
  agentCatalogEntry,
  FIXOWL_DEFAULTS,
  getAgentAdapter,
  repoFullNameSchema,
  type AgentCatalogEntry,
  type ScheduleTrigger,
} from "@fixowl/core";
import { CONFIG_PATH, loadSecrets, SECRETS_PATH } from "../config-load.ts";
import { makeContext } from "../context.ts";
import { checkDockerEngine, type EngineStatus } from "../docker/engine-check.ts";
import {
  detectInstallation,
  listAppInstallations,
  type AppInstallation,
} from "../github/app-installations.ts";
import { resolvePrivateKey, toPkcs8Pem } from "../github/app-key.ts";
import {
  appInstallUrl,
  buildAppManifest,
  defaultAppName,
  exchangeManifestCode,
  extractManifestCode,
  HEADLESS_REDIRECT_URL,
  manifestSubmitUrl,
  renderManifestFormPage,
  renderManifestRationale,
  type ManifestConversion,
} from "../github/app-manifest.ts";
import { appClient, appJwtClient, githubClient } from "../github/client.ts";
import { describeGitHubError } from "../github/errors.ts";
import { startManifestCapture } from "../github/manifest-server.ts";
import {
  ensureLabels,
  SELECTOR_LABEL_META,
  splitRepoFullName,
} from "../github/repo-provisioning.ts";
import {
  parseLabels,
  parseSchedule,
  renderConfigYaml,
  renderSecretsEnv,
  type AppCredentialAnswer,
  type RepoAnswers,
} from "../init/config-file.ts";
import { log } from "../log.ts";
import { createPrompter, maskSecret, type Prompter } from "../prompt.ts";
import { fallbackInstallCommand } from "./fallback.ts";
import { provisionCommand, type ProvisionResult } from "./provision.ts";
import { startCommand } from "./start.ts";
import { validateCommand } from "./validate.ts";

const PAT_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * Signpost to the no-admin-token route (`fixowl provision <repo> --manual`,
 * see provision-manual.ts) shown just before init asks for the admin PAT, so a
 * security-conscious operator learns it from `init` and not only from the docs.
 */
export const NO_ADMIN_SIGNPOST = `Don't want to hand fixowl an admin PAT? Press Ctrl-C and run
\`fixowl provision <repo> --manual\` instead (no admin token needed; it
prints the same setup as copy-paste steps). See docs/security.md.`;

/** Homepage the manifest pre-fills - required by GitHub, not used functionally. */
const FIXOWL_HOMEPAGE = "https://github.com/NachoPal/fixowl";

/**
 * Agents offered by the wizard, each carrying the env var(s) the operator must
 * supply. The test-only `script` adapter stays out. codex and aider each need a
 * paid API key, which their core adapters keep OUT of the default allowlist
 * (`env: []`) so it is opted in only deliberately; the wizard opts it in here by
 * naming the env var, and it is written as `agents: { <agent>: { env: [...] } }`.
 */
export const AGENT_CHOICES = [
  {
    value: "claude",
    label: "claude",
    hint: "Claude Code, driven by your Claude subscription token",
    env: ["CLAUDE_CODE_OAUTH_TOKEN"],
  },
  {
    value: "codex",
    label: "codex",
    hint: "OpenAI Codex CLI, driven by your OpenAI API key (billed as API usage)",
    env: ["OPENAI_API_KEY"],
  },
  {
    value: "aider",
    label: "aider",
    hint: "aider, driven by your Anthropic API key (billed as API usage)",
    env: ["ANTHROPIC_API_KEY"],
  },
] as const;

/** How to obtain each agent credential, keyed by the adapter's env var. */
export const AGENT_SECRET_HELP: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN:
    "Run `claude setup-token` in another terminal. It opens a browser and prints a\n" +
    "  long-lived token tied to your Claude subscription.",
  OPENAI_API_KEY:
    "Create an API key at https://platform.openai.com/api-keys. codex bills this\n" +
    "  as OpenAI API usage, separate from any ChatGPT subscription.",
  ANTHROPIC_API_KEY:
    "Create an API key at https://console.anthropic.com/settings/keys. aider bills\n" +
    "  this as Anthropic API usage.",
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

This walks you through the whole thing: the admin token and the GitHub App the
night run authenticates as, the coding agent, the repos to watch, then validates
and provisions them. Nothing is written until the questions are answered, and
every answer is stored in ${dirname(configPath)}.`);

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
  const { admin, app } = await stepTokens(prompter, secrets, secretsPath);
  const { agent, agentEnv } = await stepAgent(prompter, secrets);
  const repos = await stepRepos(prompter, admin, agent);
  // Modes 2 (host-scheduler) and 3 (both) need the host launchd agent and its
  // scoped dispatch token; mode 1 (github-cron) needs neither.
  const needsHostScheduler = repos.some((repo) => repo.scheduleTrigger !== "github-cron");
  const wantFallback = needsHostScheduler ? await stepHostSchedulerToken(prompter, secrets) : false;

  writeFileSync(
    configPath,
    renderConfigYaml({ agent, agentEnv, repos, app, fallback: wantFallback }),
  );
  log.ok(`wrote ${configPath}`);
  writeFileSync(secretsPath, renderSecretsEnv(secrets), { mode: 0o600 });
  chmodSync(secretsPath, 0o600);
  log.ok(`wrote ${secretsPath} (mode 600)`);

  await validateAndProvision(prompter, configPath, { installFallback: wantFallback });
}

// ---------------------------------------------------------------------------
// The host scheduler's scoped dispatch token
// ---------------------------------------------------------------------------

/**
 * Collect the host scheduler's least-privilege dispatch token, reached only when
 * at least one repo chose a host-scheduler mode (`host-scheduler` or `both`).
 * The token is Actions: write only, kept separate from the admin token and the
 * App so the admin token stays revocable. Returns whether the host scheduler is
 * enabled (false if the operator defers minting the token).
 */
async function stepHostSchedulerToken(
  prompter: Prompter,
  secrets: Record<string, string>,
): Promise<boolean> {
  log.info(`
Host scheduler token
--------------------
You chose to have THIS host dispatch the night run (directly on schedule, or as
a cron fallback). Dispatching the workflow needs a token with Actions: write,
which the admin token and the GitHub App deliberately do not provide for routine
use. Mint a SECOND fine-grained PAT, scoped to ONLY your target repos, granting:

  Actions: Read and write   (nothing else)

Keeping it separate means the host scheduler holds only Actions: write, so you
can still revoke or downgrade the admin token after provisioning.
Mint it at ${PAT_URL}`);
  if (!(await prompter.confirm("\nSet up the host scheduler token now?", true))) {
    log.info(
      "Skipped. The host scheduler will not run until you add FIXOWL_FALLBACK_TOKEN and run: fixowl fallback install",
    );
    return false;
  }
  await prompter.pause("\nPress Enter once you have the token ready ");
  secrets.FIXOWL_FALLBACK_TOKEN = (
    await askToken(prompter, {
      label: "  host scheduler token",
      existing: secrets.FIXOWL_FALLBACK_TOKEN,
    })
  ).token;
  return true;
}

// ---------------------------------------------------------------------------
// Step 1: the admin token and the GitHub App runtime credential
// ---------------------------------------------------------------------------

export async function stepTokens(
  prompter: Prompter,
  secrets: Record<string, string>,
  secretsPath: string,
): Promise<{ admin: Octokit; app: AppCredentialAnswer }> {
  log.info(`
Step 1/4  GitHub credentials
----------------------------
fixowl needs an admin token (this machine only, setup-only) plus a GitHub App,
the identity the night run pushes and calls the API with. Both are scoped to
ONLY the repos you want fixowl to touch.

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

  App      created for you next in ONE browser click (GitHub's App Manifest
           flow). Its installation token reads Checks, so the CI-gated fix loop
           is REAL (green flips a PR to ready; red keeps it a draft), and
           @octokit/auth-app auto-refreshes the token across the whole night,
           so it never hits the 1-hour expiry cliff.

Mint the admin PAT at ${PAT_URL}

${NO_ADMIN_SIGNPOST}`);
  await prompter.pause("\nPress Enter once you have the admin token ready ");

  const { token: adminToken, login } = await askToken(prompter, {
    label: "  admin token",
    existing: secrets.FIXOWL_ADMIN_TOKEN,
  });
  secrets.FIXOWL_ADMIN_TOKEN = adminToken;
  const app = await stepAppCredential(prompter, secrets, secretsPath, login);
  return { admin: githubClient(adminToken), app };
}

/**
 * Create (or adopt) the GitHub App and capture its credentials. The primary
 * path is GitHub's App Manifest one-click flow: the wizard pre-fills the whole
 * App - permissions, webhook off, name - opens the browser to GitHub's
 * confirmation page (informed consent: everything is reviewable there), and
 * receives the App ID + private key back automatically. A headless variant
 * covers SSH/no-browser hosts, and "use an existing App" is the advanced
 * escape hatch (see docs/app-auth.md). The private key is stored
 * base64-encoded so the multi-line PEM survives secrets.env; verification
 * confirms the App authenticates and holds Checks: read - the honest
 * pre-flight for the whole reason to use an App - plus the write permissions
 * the night needs.
 */
async function stepAppCredential(
  prompter: Prompter,
  secrets: Record<string, string>,
  secretsPath: string,
  login: string | undefined,
): Promise<AppCredentialAnswer> {
  log.info(`
GitHub App setup - one browser click
------------------------------------
fixowl pre-fills the App for you; GitHub shows it all for review before
anything is created. What is being pre-filled, and why:

${renderManifestRationale("  ")}

Creating the App does NOT yet grant access to any repo - installing it (the
next step) is where you choose the repositories fixowl may touch.`);

  for (;;) {
    const mode = await prompter.choose<"browser" | "headless" | "existing">(
      "\nHow do you want to set up the App?",
      [
        {
          value: "browser",
          label: "One-click create (recommended)",
          hint: "opens your browser; credentials are captured automatically",
        },
        {
          value: "headless",
          label: "Headless create",
          hint: "no browser on this host; you paste one code back",
        },
        {
          value: "existing",
          label: "Use an existing App",
          hint: "advanced: enter its ID and private key yourself",
        },
      ],
    );
    if (mode === "existing") return await enterExistingApp(prompter, secrets, secretsPath);

    const name = await prompter.ask("  App name (globally unique; editable on GitHub's page)", {
      default: login !== undefined ? defaultAppName(login) : undefined,
      validate: (value) =>
        value.trim().length > 34 ? "GitHub caps App names at 34 chars" : undefined,
    });
    let org: string | undefined;
    if (
      await prompter.confirm(
        "  Create the App under an organization (needed when the target repos live in one)?",
        false,
      )
    ) {
      org = (await prompter.ask("  Organization login")).trim();
    }

    let conversion: ManifestConversion;
    try {
      conversion =
        mode === "browser"
          ? await browserManifestFlow(name.trim(), org)
          : await headlessManifestFlow(prompter, secretsPath, name.trim(), org);
    } catch (error) {
      log.warn(`App creation did not complete: ${describeError(error)}`);
      continue; // back to the mode choice; nothing was saved
    }

    // Persist the key IMMEDIATELY: GitHub hands it out exactly once, and it
    // exists nowhere else until this write.
    const privateKeyB64 = Buffer.from(conversion.pem, "utf8").toString("base64");
    secrets.FIXOWL_APP_PRIVATE_KEY = privateKeyB64;
    writeFileSync(secretsPath, renderSecretsEnv(secrets), { mode: 0o600 });
    chmodSync(secretsPath, 0o600);
    log.ok(
      `created GitHub App "${conversion.slug}" (id ${conversion.appId}); private key saved to ${secretsPath}`,
    );

    const appId = String(conversion.appId);
    const installationId = await detectInstallationId(prompter, {
      appId,
      privateKeyB64,
      slug: conversion.slug,
      freshlyCreated: true,
    });
    const check = await verifyApp(appId, installationId, privateKeyB64);
    if (check.ok) log.ok(check.message);
    // The App was just created from our own manifest, so a failed check means
    // something outside the wizard (e.g. the install); `fixowl validate`
    // re-checks before provisioning either way.
    else log.warn(`${check.message}\n  Continuing; \`fixowl validate\` re-checks this.`);
    return { appId, installationId };
  }
}

/**
 * The primary manifest path: a loopback-only server serves the auto-submitting
 * manifest form and catches GitHub's redirect, so the App ID and private key
 * arrive without the user copying anything.
 */
async function browserManifestFlow(
  name: string,
  org: string | undefined,
): Promise<ManifestConversion> {
  const state = randomBytes(16).toString("hex");
  const capture = await startManifestCapture({
    state,
    pageForRedirect: (redirectUrl) =>
      renderManifestFormPage(
        buildAppManifest({ name, homepageUrl: FIXOWL_HOMEPAGE, redirectUrl }),
        manifestSubmitUrl({ org, state }),
      ),
  });
  try {
    log.info(`
Opening your browser. Review the pre-filled App on GitHub's page and click
"Create GitHub App". If no browser opened, visit:
  ${capture.url}`);
    openBrowser(capture.url);
    const code = await capture.code;
    log.info("  received the creation code from GitHub; exchanging it…");
    return await exchangeManifestCode(code);
  } finally {
    capture.close();
  }
}

/**
 * The headless variant: the manifest form is written to an HTML file the user
 * opens in ANY browser (copy it to a laptop when this host is remote), and the
 * redirect lands on github.com with the code in the address bar - no localhost
 * server, nothing to reach this machine. Same one-hour conversion window.
 */
async function headlessManifestFlow(
  prompter: Prompter,
  secretsPath: string,
  name: string,
  org: string | undefined,
): Promise<ManifestConversion> {
  const state = randomBytes(16).toString("hex");
  const page = renderManifestFormPage(
    buildAppManifest({ name, homepageUrl: FIXOWL_HOMEPAGE, redirectUrl: HEADLESS_REDIRECT_URL }),
    manifestSubmitUrl({ org, state }),
  );
  const pagePath = join(dirname(secretsPath), "app-manifest.html");
  writeFileSync(pagePath, page);
  log.info(`
Wrote ${pagePath} (no secrets in it).
1. Open that file in any browser - copy it to your own machine first if this
   host is remote (e.g. scp).
2. Review the pre-filled App on GitHub's page and click "Create GitHub App".
3. You land back on ${HEADLESS_REDIRECT_URL} with ?code=… in the
   address bar. Paste the code (or the whole URL) here within 1 hour.`);
  const answer = await prompter.ask("  code (or the full redirected URL)", {
    validate: (value) =>
      extractManifestCode(value) === undefined
        ? "no code found; paste the code= value or the full URL from the address bar"
        : undefined,
  });
  const code = extractManifestCode(answer);
  if (code === undefined) throw new Error("unreachable: validated answer had no code");
  const conversion = await exchangeManifestCode(code);
  rmSync(pagePath, { force: true });
  return conversion;
}

/** Best-effort `open`/`xdg-open`; the URL is printed anyway if this fails. */
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Non-fatal: the wizard already printed the URL to visit manually.
  }
}

/**
 * Install guidance + Installation ID auto-detection. The manifest creates the
 * App but cannot install it: the user still picks the repositories, on GitHub.
 * Since the CLI now holds the private key it then authenticates as the App and
 * lists installations itself, instead of sending the user to dig the ID out of
 * a settings URL. Falls back to asking when the API cannot be read.
 */
async function detectInstallationId(
  prompter: Prompter,
  options: { appId: string; privateKeyB64: string; slug?: string; freshlyCreated: boolean },
): Promise<string> {
  let client;
  try {
    client = appJwtClient(
      Number(options.appId),
      toPkcs8Pem(resolvePrivateKey(options.privateKeyB64)),
    );
  } catch (error) {
    log.warn(`cannot authenticate as the App to list installations: ${describeError(error)}`);
    return await askInstallationId(prompter);
  }

  const installHint =
    options.slug !== undefined
      ? appInstallUrl(options.slug)
      : "https://github.com/settings/apps -> your App -> Install App";
  if (options.freshlyCreated) {
    const settingsHint =
      options.slug !== undefined
        ? `https://github.com/settings/apps/${options.slug}`
        : "https://github.com/settings/apps -> your App";
    log.info(`
Install the App - this is where YOU pick which repositories fixowl may touch:
  ${installHint}
Choose "Only select repositories" and pick your target repo(s).

Optional: give the App the fixowl owl logo (purely cosmetic - new Apps get a
GitHub-generated identicon; there is no API to set a logo, so it is a one-time
manual upload). At ${settingsHint}
  -> Display information -> upload assets/fixowl-app-avatar.png`);
    await prompter.pause("\nPress Enter once the App is installed ");
  }

  for (;;) {
    let installations: AppInstallation[];
    try {
      installations = await listAppInstallations(client);
    } catch (error) {
      log.warn(`could not list the App's installations: ${describeGitHubError(error)}`);
      if (await prompter.confirm("  Try again?", true)) continue;
      return await askInstallationId(prompter);
    }
    const detected = detectInstallation(installations);
    switch (detected.kind) {
      case "one":
        log.ok(
          `App installed on ${detected.installation.account} - installation id ${detected.installation.id} detected`,
        );
        return String(detected.installation.id);
      case "many":
        return String(
          await prompter.choose(
            "  The App is installed on several accounts; which installation is for fixowl?",
            detected.installations.map((install) => ({
              value: install.id,
              label: install.account,
              hint: `installation ${install.id}`,
            })),
          ),
        );
      case "none": {
        log.warn(`the App has no installations yet - install it at ${installHint}`);
        if (await prompter.confirm("  Check again?", true)) continue;
        return await askInstallationId(prompter);
      }
    }
  }
}

/** The manual fallback: the number in https://github.com/settings/installations/<id>. */
async function askInstallationId(prompter: Prompter): Promise<string> {
  return await prompter.ask(
    "  Installation ID (the number in https://github.com/settings/installations/<id>)",
    { validate: numericId },
  );
}

/**
 * The advanced path: adopt an App that already exists. Only its ID and private
 * key are typed; the Installation ID is still auto-detected via the key. The
 * required permissions live in docs/app-auth.md ("Manual App setup").
 */
async function enterExistingApp(
  prompter: Prompter,
  secrets: Record<string, string>,
  secretsPath: string,
): Promise<AppCredentialAnswer> {
  log.info(`
Using an existing App (advanced). Find the App ID on the App's settings page
("About" section) and generate/download a private key there ("Private keys"),
then base64-encode it on ONE line: base64 -i app.private-key.pem | tr -d '\\n'
Required permissions: docs/app-auth.md ("Manual App setup").`);
  for (;;) {
    const appId = await prompter.ask("  App ID (numeric)", { validate: numericId });
    const privateKeyB64 = await prompter.secret("  App private key (base64 of the .pem)", {
      existing: secrets.FIXOWL_APP_PRIVATE_KEY,
      validate: (value) =>
        /\s/.test(value.trim())
          ? "paste the base64 on one line (base64 -i app.pem | tr -d '\\n')"
          : undefined,
    });
    secrets.FIXOWL_APP_PRIVATE_KEY = privateKeyB64;
    writeFileSync(secretsPath, renderSecretsEnv(secrets), { mode: 0o600 });
    chmodSync(secretsPath, 0o600);
    const installationId = await detectInstallationId(prompter, {
      appId,
      privateKeyB64,
      freshlyCreated: false,
    });
    const check = await verifyApp(appId, installationId, privateKeyB64);
    if (check.ok) {
      log.ok(check.message);
      return { appId, installationId };
    }
    log.warn(check.message);
    if (!(await prompter.confirm("  Enter the App details again?", true))) {
      // Keep what was typed; `fixowl validate` re-checks before provisioning.
      return { appId, installationId };
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
): Promise<{ token: string; login: string | undefined }> {
  for (;;) {
    const token = await prompter.secret(options.label, {
      existing: options.existing,
      validate: (value) =>
        /\s/.test(value) ? "a token has no spaces; paste it on one line" : undefined,
    });
    const login = await whoami(token);
    if (login.ok) {
      log.ok(`authenticated as ${login.login}: ${maskSecret(token)}`);
      return { token, login: login.login };
    }
    log.warn(`GitHub rejected that token: ${login.reason}`);
    if (!(await prompter.confirm("  Enter it again?", true))) {
      return { token, login: undefined };
    }
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

export async function stepAgent(
  prompter: Prompter,
  secrets: Record<string, string>,
): Promise<{ agent: string; agentEnv: readonly string[] }> {
  log.info(`
Step 2/4  Coding agent
----------------------`);
  const agent = await prompter.choose(
    "Which agent should fix your issues?",
    AGENT_CHOICES.map(({ value, label, hint }) => ({ value, label, hint })),
  );
  // The chosen agent's env allowlist. For claude this matches the adapter's
  // built-in default; for codex/aider the adapter keeps its default empty on
  // purpose, so the wizard opts the paid key in via this override.
  const choice = AGENT_CHOICES.find((c) => c.value === agent);
  const adapter = getAgentAdapter(agent, choice?.env);

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

/** The three scheduling-trigger choices, with the reliability tradeoff. */
const SCHEDULE_TRIGGER_CHOICES: ReadonlyArray<{
  value: ScheduleTrigger;
  label: string;
  hint: string;
}> = [
  {
    value: "host-scheduler",
    label: "Host scheduler (recommended for self-hosted)",
    hint: "workflow is dispatch-only; this host dispatches the night directly on schedule (reliable timing)",
  },
  {
    value: "github-cron",
    label: "GitHub cron only",
    hint: "workflow keeps its schedule: cron; no host agent. Simple, but the cron fires late/unreliably - best with a GitHub-hosted runner",
  },
  {
    value: "both",
    label: "Both (cron + host fallback)",
    hint: "workflow keeps its cron AND this host dispatches only if the cron run is missing",
  },
];

/**
 * Ask which trigger fires the nightly run, with the reliability guidance.
 * Shaped as a standalone prompt (with an optional current-value prefill) so a
 * future `fixowl edit` command can reuse it for keep-or-change editing.
 */
export async function promptScheduleTrigger(
  prompter: Prompter,
  current?: ScheduleTrigger,
): Promise<ScheduleTrigger> {
  log.info(`
  Scheduling trigger
  ------------------
  GitHub Actions' cron is unreliable - it fires late and sometimes skips a
  night. fixowl's primary target is a self-hosted runner, so the recommended
  option is to let THIS host dispatch the run on schedule. GitHub cron is mainly
  worth it if you run on a GitHub-HOSTED runner.`);
  // Order the current value first so it is the highlighted default when editing.
  const choices =
    current === undefined
      ? SCHEDULE_TRIGGER_CHOICES
      : [
          ...SCHEDULE_TRIGGER_CHOICES.filter((choice) => choice.value === current),
          ...SCHEDULE_TRIGGER_CHOICES.filter((choice) => choice.value !== current),
        ];
  return prompter.choose("  How should the nightly run be triggered?", choices);
}

async function stepRepos(
  prompter: Prompter,
  admin: Octokit,
  agent: string,
): Promise<RepoAnswers[]> {
  log.info(`
Step 3/4  Repositories
----------------------
For each repo: which one, when the nightly run fires, which labels mark an
issue as fixowl's, the run budgets that stop the night (a spend cap - usage %
for subscription agents or a token total for API-credit agents - plus
wall-clock and an optional issue-count cap), the per-issue timeout, the
CI-gated fix loop budget, and which model the coding agent runs with.`);

  const repos: RepoAnswers[] = [];
  // The wizard's sticky-last-value defaults: the first repo starts from the
  // built-in starter values, then each repo's answers prefill the next. Model
  // selection is intentionally NOT carried forward (it stays a fresh choice per
  // repo, as it always has - so the keep-or-change path only engages in `edit`).
  let prefill: RepoSettingsPrefill = {
    schedule: "02:37",
    scheduleTrigger: "host-scheduler",
    labels: "overnight",
    maxIssuesPerRun: FIXOWL_DEFAULTS.maxIssuesPerRun,
    usageBudgetPercent: FIXOWL_DEFAULTS.usageBudgetPercent,
    totalTokenBudget: FIXOWL_DEFAULTS.totalTokenBudget,
    runBudgetMinutes: FIXOWL_DEFAULTS.runBudgetMinutes,
    issueTimeoutMinutes: FIXOWL_DEFAULTS.issueTimeoutMinutes,
    ciMaxTries: FIXOWL_DEFAULTS.ciMaxTries,
    ciTimeoutMinutes: FIXOWL_DEFAULTS.ciTimeoutMinutes,
    heuristicConflictOrdering: FIXOWL_DEFAULTS.heuristicConflictOrdering,
  };

  for (;;) {
    log.info(`\nRepo ${repos.length + 1}`);
    const name = await askRepoName(prompter, admin, repos);
    const answers = await promptRepoSettings(prompter, admin, agent, name, prefill);
    repos.push({ name, ...answers });

    // Carry this repo's non-model answers forward as the next repo's prefill.
    prefill = {
      schedule: answers.schedule,
      scheduleTrigger: answers.scheduleTrigger,
      labels: answers.labels.join(", "),
      maxIssuesPerRun: answers.maxIssuesPerRun,
      usageBudgetPercent: answers.usageBudgetPercent,
      totalTokenBudget: answers.totalTokenBudget,
      runBudgetMinutes: answers.runBudgetMinutes,
      issueTimeoutMinutes: answers.issueTimeoutMinutes ?? FIXOWL_DEFAULTS.issueTimeoutMinutes,
      ciMaxTries: answers.ciMaxTries ?? FIXOWL_DEFAULTS.ciMaxTries,
      ciTimeoutMinutes: answers.ciTimeoutMinutes ?? FIXOWL_DEFAULTS.ciTimeoutMinutes,
      heuristicConflictOrdering: answers.heuristicConflictOrdering ?? false,
    };

    if (!(await prompter.confirm("\nAdd another repo?", false))) return repos;
  }
}

/** The current/prefill values shown as each per-repo prompt's default. */
export interface RepoSettingsPrefill {
  /** Answer form: a cron ("37 1 * * *") or a local "HH:MM". */
  schedule: string;
  scheduleTrigger: ScheduleTrigger;
  /** Comma-joined labels (parseLabels reverses it). */
  labels: string;
  maxIssuesPerRun: number;
  /** undefined => blank default => the usage axis stays opted out. */
  usageBudgetPercent?: number;
  /** undefined => blank default => the token axis stays opted out. */
  totalTokenBudget?: number;
  runBudgetMinutes?: number;
  issueTimeoutMinutes: number;
  ciMaxTries: number;
  ciTimeoutMinutes: number;
  heuristicConflictOrdering: boolean;
  defaultModel?: string;
  defaultEffort?: string;
  labelModels?: Record<string, { model: string; effort: string }>;
}

/** All per-repo answers, minus `name`. Shared by `init` and `edit`. */
export type RepoSettingsAnswers = Omit<RepoAnswers, "name">;

/**
 * The per-repo question block, shared by `fixowl init` and `fixowl edit`. Each
 * prompt's default comes from `prefill`: init passes its sticky-last values, and
 * `edit` passes the repo's current resolved settings so every field is a
 * keep-or-change. The model/effort selection engages its keep-or-change path
 * only when `prefill` carries current model values (i.e. in `edit`).
 */
export async function promptRepoSettings(
  prompter: Prompter,
  admin: Octokit,
  agent: string,
  repoName: string,
  prefill: RepoSettingsPrefill,
): Promise<RepoSettingsAnswers> {
  const scheduleAnswer = await prompter.ask(
    "  Nightly run time (local HH:MM, or a 5-field UTC cron)",
    {
      default: prefill.schedule,
      validate: (value) => problemWith(() => parseSchedule(value)),
    },
  );
  const schedule = parseSchedule(scheduleAnswer);
  log.info(
    `    cron "${schedule.cron}" (UTC)${schedule.note !== undefined ? ` = ${schedule.note}` : ""}`,
  );

  const scheduleTrigger = await promptScheduleTrigger(prompter, prefill.scheduleTrigger);

  const labelsAnswer = await prompter.ask(
    "  Labels that mark an issue for fixowl (comma-separated)",
    {
      default: prefill.labels,
      validate: (value) =>
        parseLabels(value).length > 0 ? undefined : "at least one label is required",
    },
  );
  // Layered run-budget (issue #21): the night stops on the first condition
  // that trips. Each is optional; a blank answer opts that axis out. The spend
  // cap is billing-aware: a subscription agent (claude) is bounded by a % of its
  // usage window; an API-credit agent (codex/aider) is bounded by a total-token
  // cap (there is no usage window to read); a zero-spend agent (script) gets no
  // spend prompt at all.
  const billing = agentBilling(agent);
  let usageBudgetPercent: number | undefined;
  let totalTokenBudget: number | undefined;
  if (billing === "subscription") {
    const usageBudgetAnswer = await prompter.ask(
      "  Usage budget - stop the night at what % of the agent's usage window? (blank = no usage cap)",
      {
        default: prefill.usageBudgetPercent === undefined ? "" : String(prefill.usageBudgetPercent),
        validate: (value) =>
          value.trim() === "" || isPercent(value)
            ? undefined
            : "enter a percent 0-100, or leave blank for no usage cap",
      },
    );
    usageBudgetPercent = usageBudgetAnswer.trim() === "" ? undefined : Number(usageBudgetAnswer);
  } else if (billing === "api-credit") {
    const tokenBudgetAnswer = await prompter.ask(
      "  Token budget - stop the night once the agent has spent how many tokens? (blank = no token cap)",
      {
        default: prefill.totalTokenBudget === undefined ? "" : String(prefill.totalTokenBudget),
        validate: (value) =>
          value.trim() === "" || /^[1-9]\d*$/.test(value.trim())
            ? undefined
            : "enter a positive whole number of tokens, or leave blank for no token cap",
      },
    );
    totalTokenBudget = tokenBudgetAnswer.trim() === "" ? undefined : Number(tokenBudgetAnswer);
  }
  const runBudgetAnswer = await prompter.ask(
    "  Graceful run budget - don't start a new issue after how many minutes? (blank = none)",
    {
      default: prefill.runBudgetMinutes === undefined ? "" : String(prefill.runBudgetMinutes),
      validate: (value) =>
        value.trim() === "" || /^[1-9]\d*$/.test(value.trim())
          ? undefined
          : "enter a positive whole number of minutes, or leave blank",
    },
  );
  const maxIssuesAnswer = await prompter.ask(
    "  Optional hard cap - max issues per night (secondary count cap)",
    {
      default: String(prefill.maxIssuesPerRun),
      validate: (value) => (/^[1-9]\d*$/.test(value) ? undefined : "enter a positive whole number"),
    },
  );
  const issueTimeoutAnswer = await prompter.ask(
    "  Per-issue timeout in minutes (a stuck agent is killed after this)",
    {
      default: String(prefill.issueTimeoutMinutes),
      validate: (value) => (/^[1-9]\d*$/.test(value) ? undefined : "enter a positive whole number"),
    },
  );
  const ciMaxTriesAnswer = await prompter.ask(
    "  CI-gated fix loop - max agent passes before leaving a draft PR",
    {
      default: String(prefill.ciMaxTries),
      validate: (value) => (/^[1-9]\d*$/.test(value) ? undefined : "enter a positive whole number"),
    },
  );
  const ciTimeoutAnswer = await prompter.ask(
    "  CI-gated fix loop - minutes each pass waits for the base branch's required checks",
    {
      default: String(prefill.ciTimeoutMinutes),
      validate: (value) => (/^[1-9]\d*$/.test(value) ? undefined : "enter a positive whole number"),
    },
  );
  const heuristicConflictOrdering = await prompter.confirm(
    "  Enable Layer-2 heuristic conflict ordering (a paid LLM groups & stacks same-file issues)?",
    prefill.heuristicConflictOrdering,
  );

  const labels = parseLabels(labelsAnswer);
  const current =
    prefill.defaultModel !== undefined ||
    prefill.defaultEffort !== undefined ||
    (prefill.labelModels !== undefined && Object.keys(prefill.labelModels).length > 0)
      ? {
          defaultModel: prefill.defaultModel,
          defaultEffort: prefill.defaultEffort,
          labelModels: prefill.labelModels,
        }
      : undefined;
  const modelSelection = await stepModelSelection(
    prompter,
    admin,
    repoName,
    agent,
    await fetchLabelCandidates(admin, repoName, labels),
    current,
  );

  return {
    schedule: schedule.cron,
    scheduleNote: schedule.note,
    scheduleTrigger,
    labels,
    maxIssuesPerRun: Number(maxIssuesAnswer),
    usageBudgetPercent,
    totalTokenBudget,
    runBudgetMinutes: runBudgetAnswer.trim() === "" ? undefined : Number(runBudgetAnswer),
    issueTimeoutMinutes: Number(issueTimeoutAnswer),
    ciMaxTries: Number(ciMaxTriesAnswer),
    ciTimeoutMinutes: Number(ciTimeoutAnswer),
    heuristicConflictOrdering,
    ...modelSelection,
  };
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

/** True when a current model selection carries at least one selector-label mapping. */
function hasLabelModels(current: ModelSelectionAnswers | undefined): boolean {
  return current?.labelModels !== undefined && Object.keys(current.labelModels).length > 0;
}

/**
 * Show the current value and keep it on Yes (the default), or open the chooser
 * on No. With no current value (init's fresh flow) the chooser opens directly,
 * so `stepModelSelection` is byte-for-byte unchanged when `current` is undefined.
 */
async function keepOrChange<T>(
  prompter: Prompter,
  label: string,
  current: T | undefined,
  choose: () => Promise<T>,
): Promise<T> {
  if (current === undefined) return await choose();
  return (await prompter.confirm(`  Keep ${label} = ${String(current)}?`, true))
    ? current
    : await choose();
}

/**
 * Captures either a per-label mapping (one model+effort per selector label) or
 * a single default, or neither (fall through to the agent CLI's own default).
 * Every list here is arrow-key driven and sourced from the agent catalog, so an
 * agent with no model/effort axis asks nothing at all.
 *
 * `current` is `fixowl edit`'s keep-or-change prefill: the confirms default from
 * it and each model/effort is wrapped in `keepOrChange`. When it is undefined
 * (init's flow) behaviour is byte-for-byte identical to the fresh wizard.
 */
async function stepModelSelection(
  prompter: Prompter,
  admin: Octokit,
  name: string,
  agent: string,
  labelCandidates: readonly string[],
  current?: ModelSelectionAnswers,
): Promise<ModelSelectionAnswers> {
  const catalog = agentCatalogEntry(agent);
  if (catalog === undefined) return {}; // agent has no model/effort axis; nothing to ask

  log.info(`
  Model selection for "${agent}" (${catalog.models.length} models, efforts: ${catalog.efforts.join(", ")})`);

  const answers: ModelSelectionAnswers = {};

  const wantsLabels = await prompter.confirm(
    "\n  Map specific labels to a model + effort (heavy issues get a bigger model)?",
    hasLabelModels(current),
  );
  if (wantsLabels) {
    const labelModels: Record<string, { model: string; effort: string }> = {};
    for (const label of await chooseSelectorLabels(prompter, admin, name, labelCandidates)) {
      const currentChoice = current?.labelModels?.[label];
      const model = await keepOrChange(prompter, `model for "${label}"`, currentChoice?.model, () =>
        chooseModel(prompter, catalog, `  Model for "${label}"`),
      );
      const effort = await keepOrChange(
        prompter,
        `effort for "${label}"`,
        currentChoice?.effort,
        () => chooseEffort(prompter, catalog, `  Effort for "${label}"`),
      );
      labelModels[label] = { model, effort };
    }
    if (Object.keys(labelModels).length > 0) answers.labelModels = labelModels;
  }

  const setDefault = await prompter.confirm(
    wantsLabels
      ? "\n  Set a default model + effort for issues carrying none of those labels?"
      : "\n  Set a default model + effort for this repo (No = use the agent's own default)?",
    current === undefined ? !wantsLabels : current.defaultModel !== undefined,
  );
  if (setDefault) {
    answers.defaultModel = await keepOrChange(
      prompter,
      "default model",
      current?.defaultModel,
      () => chooseModel(prompter, catalog, "  Default model"),
    );
    answers.defaultEffort = await keepOrChange(
      prompter,
      "default effort",
      current?.defaultEffort,
      () => chooseEffort(prompter, catalog, "  Default effort"),
    );
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
  admin: Octokit,
  name: string,
  candidates: readonly string[],
): Promise<string[]> {
  const chosen = await pickSelectorLabels(prompter, candidates);
  await offerToCreateSelectorLabels(prompter, admin, name, chosen, candidates);
  return chosen;
}

async function pickSelectorLabels(
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

/**
 * Offers to create any chosen selector labels that don't exist in the repo yet,
 * detected against the already-fetched candidate list (no extra GitHub read).
 * On yes, creates them now with the admin token (Issues: write) via the same
 * idempotent helper provision uses, with a selector-appropriate description.
 *
 * Purely an early-feedback UX win: provision (Step 4) back-fills any labels
 * regardless, so this is best-effort - a creation failure warns and continues,
 * never aborting init.
 */
export async function offerToCreateSelectorLabels(
  prompter: Prompter,
  admin: Octokit,
  name: string,
  chosen: readonly string[],
  existing: readonly string[],
): Promise<void> {
  const missing = chosen.filter((label) => !existing.includes(label));
  if (missing.length === 0) return;

  const one = missing.length === 1;
  const create = await prompter.confirm(
    `\n  ${missing.length} selector label${one ? "" : "s"} ${one ? "doesn't" : "don't"} ` +
      `exist yet: ${missing.join(", ")}. Create ${one ? "it" : "them"} now?`,
    true,
  );
  if (!create) return;

  try {
    const created = await ensureLabels(
      admin,
      splitRepoFullName(name),
      missing,
      SELECTOR_LABEL_META,
    );
    log.ok(created.length > 0 ? `labels created: ${created.join(", ")}` : "labels already present");
  } catch (error) {
    log.warn(
      `could not create selector labels now (${describeGitHubError(error)}); ` +
        `they'll be created when you provision.`,
    );
  }
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

/** The width of the ACTIONS NEEDED banner rule. */
const ACTIONS_RULE = "═".repeat(64);

export interface ActionsNeeded {
  /** The rendered ACTIONS NEEDED block, ready to hand to `log.info`. */
  block: string;
  /** Whether init should pause for the user to merge before starting the runner. */
  pause: boolean;
}

/**
 * Turn the PRs `fixowl provision` opened into a prominent, unmissable "ACTIONS
 * NEEDED" block for the end of init. The workflow PR(s) are REQUIRED - scheduled
 * runs stay inert until they are merged onto the default branch - so their
 * presence makes init pause before it offers to start the runner. Starter-files
 * PR(s) are listed as an optional follow-up (edit the verify commands, then
 * merge). When provisioning opened nothing to merge, the block degrades to a
 * short "nothing to merge" note and init does not pause.
 */
export function renderActionsNeeded(result: ProvisionResult): ActionsNeeded {
  const required = result.prs.filter((pr) => pr.kind === "workflow");
  const optional = result.prs.filter((pr) => pr.kind === "starter-files");

  const header = `\n${ACTIONS_RULE}\n  ⚠️  ACTIONS NEEDED\n${ACTIONS_RULE}`;

  if (required.length === 0 && optional.length === 0) {
    return {
      block: `${header}
  Nothing to merge - provisioning opened no pull requests (the workflow and
  starter files are already on the default branch). You're ready to start the
  runner.`,
      pause: false,
    };
  }

  const lines: string[] = [header];
  if (required.length > 0) {
    lines.push(`
  Merge the following PR(s) before starting the runner - scheduled runs do NOT
  activate until the fixowl workflow is on each repo's default branch:
`);
    for (const pr of required) lines.push(`    • ${pr.url}   (${pr.repo})`);
  }
  if (optional.length > 0) {
    lines.push(`
  Also proposed (optional - review and edit the verify commands, then merge
  when you're ready):
`);
    for (const pr of optional) lines.push(`    • ${pr.url}   (${pr.repo})`);
  }
  lines.push(`\n${ACTIONS_RULE}`);

  // Only a required (workflow) PR is worth blocking on; a lone starter-files PR
  // is an edit-then-merge follow-up that need not gate the runner.
  return { block: lines.join("\n"), pause: required.length > 0 };
}

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
  let provisionResult: ProvisionResult;
  try {
    provisionResult = await provisionCommand(ctx, undefined, {});
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

  // Spell out the required next actions - chiefly merging the provision PR(s) -
  // as a prominent block, and pause here so the user can merge BEFORE we offer
  // to start the runner (a runner started against an unmerged workflow does
  // nothing at night).
  const actions = renderActionsNeeded(provisionResult);
  log.info(actions.block);
  if (actions.pause) {
    await prompter.pause("\nOnce those PR(s) are merged, press Enter to continue ");
  }

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
        "the host scheduler is macOS-only for now; on Linux add a cron/systemd-timer\n" +
          "  that runs `fixowl fallback check` on schedule.",
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
          "\nThe host scheduler did not install. Fix the problem above and re-run: fixowl fallback install",
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  log.info(`
🦉 fixowl is set up.

  ${
    actions.pause
      ? "Once the PR(s) above are merged, file an issue, add the label you chose, and\n  check back tomorrow."
      : "File an issue, add the label you chose, and check back tomorrow."
  }
  fixowl status              # runner, last run, open fixowl PRs
  fixowl run owner/repo      # do not wait for the cron; run a night now
  fixowl logs owner/repo     # what happened last night${
    options.installFallback === true
      ? "\n  fixowl fallback status     # host scheduler: installed? mode? next fire?"
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
  app:                                     # GitHub App: the night run's only credential (real CI-gating; auto-refreshing token). See docs/app-auth.md.
    app_id: 123456                         # App settings page, "About" section
    installation_id: 7890123               # the number in https://github.com/settings/installations/<id>
    private_key: \${FIXOWL_APP_PRIVATE_KEY} # base64 of the downloaded App .pem (normalized to PKCS#8 at provision)
  # fallback_token: \${FIXOWL_FALLBACK_TOKEN}  # host-scheduler modes only; fine-grained PAT, Actions: write only

# runner:
#   dir: ~/.fixowl/runners   # must live under $HOME (Colima shares $HOME with its VM)

# fallback:
#   gap_minutes: 30          # "both" mode only: minutes after the cron the host fallback fires (default 30)

defaults:
  schedule: "37 1 * * *"     # UTC; odd minute dodges GitHub's peak-time cron delays
  schedule_trigger: host-scheduler   # host launchd dispatches on schedule (recommended for self-hosted);
                                     #   alternatives: github-cron (cron only), both (cron + host fallback)
  labels: { any: [overnight] }
  agent: claude
  # Layered run-budget (issue #21): the night stops on the first condition that
  # trips. Each is optional; delete/omit a line to opt that axis out.
  max_issues_per_run: 4        # secondary cap: at most this many PRs ship
  # usage_budget_percent: 85       # subscription agents: stop once the usage window hits this %
  # total_token_budget: 3000000    # API-credit agents (codex/aider): stop once total token spend hits this
  # run_budget_minutes: 240        # graceful wall-clock: don't start a new issue after this long
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
FIXOWL_APP_PRIVATE_KEY=
CLAUDE_CODE_OAUTH_TOKEN=
# FIXOWL_APP_PRIVATE_KEY is the base64 of the downloaded App .pem, on ONE line
# (base64 -i app.pem | tr -d '\\n'); see docs/app-auth.md.
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
     Then set up the GitHub App the night run authenticates as (its
     installation token reads Checks, which makes the CI gate real). The
     easy way is \`fixowl init\` on an interactive terminal: it creates the
     App for you in one browser click via GitHub's App Manifest flow and
     captures the App ID and private key automatically. To create it by
     hand instead, follow "Manual App setup (advanced)" in docs/app-auth.md,
     then put the App ID and Installation ID in the github.app block of the
     config and the base64 of the .pem (base64 -i app.private-key.pem |
     tr -d '\\n') in ${secretsPath} as FIXOWL_APP_PRIVATE_KEY.
  2. If using the claude agent: run \`claude setup-token\` and put the resulting
     token in ${secretsPath} as CLAUDE_CODE_OAUTH_TOKEN.
  3. Edit ${configPath}: list your repos.
  4. Run \`fixowl validate\`, then \`fixowl provision\` and \`fixowl start\`.
  5. Scheduling trigger (defaults.schedule_trigger): host-scheduler (recommended
     for self-hosted; the workflow is dispatch-only and this host dispatches on
     schedule), github-cron (workflow keeps its cron; no host agent), or both
     (cron + host fallback). For host-scheduler or both, mint a SECOND
     fine-grained PAT with ONLY Actions: write on your repos, put it in
     ${secretsPath} as FIXOWL_FALLBACK_TOKEN, uncomment github.fallback_token in
     the config, then run \`fixowl fallback install\` (macOS). See docs/local-fallback.md.`);
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
