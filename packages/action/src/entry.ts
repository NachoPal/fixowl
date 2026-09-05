import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import {
  labelModelsSchema,
  RUNTIME_TOKEN_SECRET,
  SCHEDULED_FALLBACK_SOURCE,
  type LabelModelMap,
  type LabelRule,
} from "@fixowl/core";
import { GitHubArtifactUploader } from "./artifact-upload.ts";
import { DockerEngine } from "./container-exec.ts";
import type { Logger } from "./deps.ts";
import { makeGitHubApi } from "./github-api.ts";
import { renderSummary, runNight, wipeoutFailure } from "./main.ts";
import { realExec } from "./real-exec.ts";

/** Real-world wiring for the action; all logic lives in main.ts behind fakes-friendly deps. */

const log: Logger = {
  info: (message) => core.info(message),
  warn: (message) => core.warning(message),
  error: (message) => core.error(message),
};

function parseLabelInput(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`required env var ${name} is not set`);
  }
  return value;
}

/** Parses the label-models JSON input, validating its shape against the shared schema. */
function parseLabelModelsInput(raw: string): LabelModelMap {
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`input label-models is not valid JSON: ${raw}`);
  }
  return labelModelsSchema.parse(parsed);
}

/** Parses a boolean input; a hand-edited workflow with garbage fails loudly. */
function booleanInput(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name);
  if (raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`input ${name} must be "true" or "false", got "${raw}"`);
}

/** A hand-edited workflow with a bad number must fail loudly, not as NaN weirdness. */
function positiveIntInput(name: string, fallback: number): number {
  const raw = core.getInput(name);
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`input ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/** An optional positive-int input: blank opts the run-budget axis out (undefined). */
function optionalPositiveIntInput(name: string): number | undefined {
  const raw = core.getInput(name);
  if (raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`input ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/** An optional percent input (0..100); blank opts the usage axis out (undefined). */
function optionalPercentInput(name: string): number | undefined {
  const raw = core.getInput(name);
  if (raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`input ${name} must be a number between 0 and 100, got "${raw}"`);
  }
  return value;
}

/**
 * The single network edge for out-of-band usage reads (issue #21). Rejects on a
 * non-2xx so the reader treats it as unobservable and abstains. Kept here at the
 * action boundary; the pure reader in @fixowl/core does no I/O of its own.
 */
async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`usage read failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function run(): Promise<void> {
  const token = requireEnv(RUNTIME_TOKEN_SECRET);
  const repoFullName = requireEnv("GITHUB_REPOSITORY");
  const workspaceDir = requireEnv("GITHUB_WORKSPACE");
  const tempDir = requireEnv("RUNNER_TEMP");
  const [owner, repo] = repoFullName.split("/");
  if (owner === undefined || repo === undefined) {
    throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${repoFullName}`);
  }

  const labels: LabelRule = {
    any: parseLabelInput(core.getInput("labels-any")),
    all: parseLabelInput(core.getInput("labels-all")),
  };
  if ((labels.any?.length ?? 0) === 0 && (labels.all?.length ?? 0) === 0) {
    throw new Error("no labels configured; set labels-any or labels-all");
  }

  const agentName = core.getInput("agent") || "claude";
  // The script adapter executes issue bodies as shell; it exists for fixowl's
  // own tests, where the fake GitHub is the only issue source. On a real repo
  // that would be remote code execution for anyone who can file an issue.
  if (agentName === "script" && process.env.FIXOWL_UNSAFE_SCRIPT_AGENT !== "1") {
    throw new Error(
      'agent "script" executes issue bodies as shell and is for fixowl\'s own tests; ' +
        "set FIXOWL_UNSAFE_SCRIPT_AGENT=1 in the workflow env if you really mean it",
    );
  }

  const octokit = new Octokit({ auth: token });
  const { data: repoData } = await octokit.repos.get({ owner, repo });

  // The scheduled-slot budget guard lists workflow runs (Actions: read). That
  // uses the ephemeral GITHUB_TOKEN the workflow injects, never the runtime PAT,
  // so the most-exposed credential stays minimal. A workflow provisioned before
  // this feature passes no GITHUB_TOKEN; the guard then fails open (see main.ts).
  const guardToken = process.env.GITHUB_TOKEN;
  const runsOctokit =
    guardToken !== undefined && guardToken !== "" ? new Octokit({ auth: guardToken }) : undefined;

  // A scheduled-slot run is the cron (event: schedule) or a fallback-tagged
  // dispatch (source: scheduled-fallback). A plain manual dispatch is neither
  // and is never budget-limited.
  const scheduledSlot =
    process.env.GITHUB_EVENT_NAME === "schedule" ||
    core.getInput("source") === SCHEDULED_FALLBACK_SOURCE;
  const currentRunId =
    process.env.GITHUB_RUN_ID !== undefined && process.env.GITHUB_RUN_ID !== ""
      ? Number(process.env.GITHUB_RUN_ID)
      : undefined;

  const runUrl =
    process.env.GITHUB_SERVER_URL !== undefined && process.env.GITHUB_RUN_ID !== undefined
      ? `${process.env.GITHUB_SERVER_URL}/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  const summary = await runNight(
    {
      github: makeGitHubApi(octokit, owner, repo, runsOctokit),
      engine: new DockerEngine(realExec, log),
      exec: realExec,
      log,
      httpJson: fetchJson,
      artifacts: new GitHubArtifactUploader(),
    },
    {
      repoFullName,
      defaultBranch: repoData.default_branch,
      scheduledSlot,
      currentRunId,
      cronSchedule: core.getInput("schedule") || undefined,
      labels,
      agentName,
      agentEnvNames: parseLabelInput(core.getInput("agent-env")),
      maxIssues: positiveIntInput("max-issues-per-run", 4),
      usageBudgetPercent: optionalPercentInput("usage-budget-percent"),
      runBudgetMinutes: optionalPositiveIntInput("run-budget-minutes"),
      issueTimeoutMinutes: positiveIntInput("issue-timeout-minutes", 45),
      ciMaxTries: positiveIntInput("max-ci-tries", 3),
      ciTimeoutMinutes: positiveIntInput("ci-timeout-minutes", 60),
      defaultModel: core.getInput("default-model") || undefined,
      defaultEffort: core.getInput("default-effort") || undefined,
      labelModels: parseLabelModelsInput(core.getInput("label-models")),
      heuristicConflictOrdering: booleanInput("heuristic-conflict-ordering", false),
      workspaceDir,
      tempDir,
      runUrl,
      pushToken: token,
      env: process.env,
    },
  );

  await core.summary.addRaw(renderSummary(repoFullName, summary)).write();

  const infraErrors = summary.results.filter((result) => result.status === "error");
  if (infraErrors.length > 0) {
    core.warning(`${infraErrors.length} issue(s) hit unexpected errors; see the summary`);
  }

  // A total wipeout - shippable issues selected, every one failed, nothing
  // opened - must fail the job so a silent green never hides a full outage.
  const wipeout = wipeoutFailure(summary);
  if (wipeout !== undefined) {
    core.setFailed(`🦉 fixowl: ${wipeout}`);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
