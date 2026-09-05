import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import {
  labelModelsSchema,
  RUNTIME_TOKEN_SECRET,
  SCHEDULED_FALLBACK_SOURCE,
  type LabelModelMap,
  type LabelRule,
} from "@fixowl/core";
import { DockerEngine } from "./container-exec.ts";
import type { GitHubApi, IssueDeps, IssueLite, Logger } from "./deps.ts";
import { renderSummary, runNight, wipeoutFailure } from "./main.ts";
import { realExec } from "./real-exec.ts";

/** Real-world wiring for the action; all logic lives in main.ts behind fakes-friendly deps. */

const log: Logger = {
  info: (message) => core.info(message),
  warn: (message) => core.warning(message),
  error: (message) => core.error(message),
};

/**
 * @param octokit runtime-PAT client for issues/PRs (the night's write path).
 * @param runsOctokit client with Actions: read (the ephemeral GITHUB_TOKEN) for
 *   the scheduled-slot guard's runs query; undefined disables the guard's fetch.
 */
function makeGitHubApi(
  octokit: Octokit,
  owner: string,
  repo: string,
  runsOctokit: Octokit | undefined,
): GitHubApi {
  return {
    async listOpenIssuesWithLabels(labelsQuery: string): Promise<IssueLite[]> {
      const issues = await octokit.paginate(octokit.issues.listForRepo, {
        owner,
        repo,
        state: "open",
        labels: labelsQuery,
        per_page: 100,
      });
      return issues
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          labels: issue.labels.map((label) =>
            typeof label === "string" ? label : (label.name ?? ""),
          ),
        }));
    },
    async createPullRequest(params) {
      const response = await octokit.pulls.create({
        owner,
        repo,
        head: params.head,
        base: params.base,
        title: params.title,
        body: params.body,
        draft: params.draft,
      });
      return { number: response.data.number, url: response.data.html_url };
    },
    async createIssueComment(issueNumber, body) {
      await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    },
    async listRecentWorkflowRuns() {
      if (runsOctokit === undefined) return [];
      const { data } = await runsOctokit.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: "fixowl.yml",
        per_page: 50,
      });
      return data.workflow_runs.map((workflowRun) => ({
        id: workflowRun.id,
        event: workflowRun.event,
        status: workflowRun.status ?? null,
        createdAt: workflowRun.created_at,
        displayTitle: workflowRun.display_title ?? workflowRun.name ?? "",
      }));
    },
    async getIssueDependencies(numbers: readonly number[]): Promise<Map<number, IssueDeps>> {
      const result = new Map<number, IssueDeps>();
      if (numbers.length === 0) return result;
      // One aliased GraphQL round-trip; `first: 50` covers the whole set (GitHub
      // caps blockers at 50 per issue), and each node carries repo + state so a
      // cross-repo or closed blocker is classified without a second fetch.
      const aliases = numbers
        .map(
          (n) =>
            `i${n}: issue(number: ${n}) { number blockedBy(first: 50) { totalCount nodes { number state repository { nameWithOwner } } } }`,
        )
        .join("\n");
      const query = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${aliases} } }`;
      const data = await octokit.graphql<{ repository: Record<string, GraphqlIssueNode | null> }>(
        query,
        { owner, repo },
      );
      const repository = data.repository ?? {};
      for (const n of numbers) {
        const node = repository[`i${n}`];
        const connection = node?.blockedBy;
        const nodes = connection?.nodes ?? [];
        const blockedBy = nodes
          .filter((edge): edge is NonNullable<typeof edge> => edge !== null)
          .map((edge) => ({
            number: edge.number,
            repo: edge.repository.nameWithOwner,
            state: edge.state,
          }));
        result.set(n, {
          number: n,
          blockedBy,
          blockedByOverflow: (connection?.totalCount ?? 0) > blockedBy.length,
        });
      }
      return result;
    },
  };
}

interface GraphqlIssueNode {
  number: number;
  blockedBy: {
    totalCount: number;
    nodes: Array<{
      number: number;
      state: "OPEN" | "CLOSED";
      repository: { nameWithOwner: string };
    } | null> | null;
  } | null;
}

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
      issueTimeoutMinutes: positiveIntInput("issue-timeout-minutes", 45),
      defaultModel: core.getInput("default-model") || undefined,
      defaultEffort: core.getInput("default-effort") || undefined,
      labelModels: parseLabelModelsInput(core.getInput("label-models")),
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
