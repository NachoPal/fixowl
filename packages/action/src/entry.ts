import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { RUNTIME_TOKEN_SECRET, type LabelRule } from "@fixowl/core";
import { DockerEngine } from "./container-exec.ts";
import type { GitHubApi, IssueLite, Logger } from "./deps.ts";
import { renderSummary, runNight } from "./main.ts";
import { realExec } from "./real-exec.ts";

/** Real-world wiring for the action; all logic lives in main.ts behind fakes-friendly deps. */

const log: Logger = {
  info: (message) => core.info(message),
  warn: (message) => core.warning(message),
  error: (message) => core.error(message),
};

function makeGitHubApi(octokit: Octokit, owner: string, repo: string): GitHubApi {
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
  };
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

  const octokit = new Octokit({ auth: token });
  const { data: repoData } = await octokit.repos.get({ owner, repo });

  const runUrl =
    process.env.GITHUB_SERVER_URL !== undefined && process.env.GITHUB_RUN_ID !== undefined
      ? `${process.env.GITHUB_SERVER_URL}/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  const summary = await runNight(
    {
      github: makeGitHubApi(octokit, owner, repo),
      engine: new DockerEngine(realExec, log),
      exec: realExec,
      log,
    },
    {
      repoFullName,
      defaultBranch: repoData.default_branch,
      labels,
      agentName: core.getInput("agent") || "claude",
      agentEnvNames: parseLabelInput(core.getInput("agent-env")),
      maxIssues: Number(core.getInput("max-issues-per-run") || "4"),
      issueTimeoutMinutes: Number(core.getInput("issue-timeout-minutes") || "45"),
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
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
