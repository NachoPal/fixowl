import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import {
  labelModelsSchema,
  RUNTIME_TOKEN_SECRET,
  SCHEDULED_FALLBACK_SOURCE,
  type CheckStatusLite,
  type LabelModelMap,
  type LabelRule,
  type RequiredChecks,
} from "@fixowl/core";
import { DockerEngine } from "./container-exec.ts";
import type { GitHubApi, IssueDeps, IssueLite, Logger, PullRequestLite } from "./deps.ts";
import { renderSummary, runNight, wipeoutFailure } from "./main.ts";
import { realExec } from "./real-exec.ts";

/** Real-world wiring for the action; all logic lives in main.ts behind fakes-friendly deps. */

/** Longest job-log tail fetched for a red check before the prompt fence caps it further. */
const CHECK_LOG_MAX = 6000;

/** Shape of the `parameters` on a branch-rules `required_status_checks` rule. */
interface RequiredStatusChecksParameters {
  required_status_checks?: Array<{ context: string; integration_id?: number }>;
}

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
    async ensurePullRequest(params) {
      const { data: existing } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        head: `${owner}:${params.head}`,
      });
      const open = existing[0];
      if (open !== undefined) return { number: open.number, url: open.html_url };
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
    async markPullRequestReadyForReview(prNumber) {
      const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
      // No REST endpoint flips draft->ready; the GraphQL mutation takes the node id.
      await octokit.graphql(
        `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id: data.node_id },
      );
    },
    async updatePullRequestBody(prNumber, body) {
      await octokit.pulls.update({ owner, repo, pull_number: prNumber, body });
    },
    async getRequiredChecks(baseBranch): Promise<RequiredChecks> {
      // The branch-rules endpoint surfaces required status checks from both
      // classic branch protection and rulesets, and is readable with the
      // runtime token's Administration: read. Any failure (no protection,
      // insufficient scope) degrades to the "gate on all checks" fallback.
      try {
        const { data } = await octokit.repos.getBranchRules({ owner, repo, branch: baseBranch });
        const contexts = new Set<string>();
        for (const rule of data) {
          if (rule.type !== "required_status_checks") continue;
          const params = (rule as { parameters?: RequiredStatusChecksParameters }).parameters;
          for (const check of params?.required_status_checks ?? []) {
            if (check.context !== "") contexts.add(check.context);
          }
        }
        return { readable: contexts.size > 0, contexts: [...contexts] };
      } catch {
        return { readable: false, contexts: [] };
      }
    },
    async getChecksForRef(sha): Promise<CheckStatusLite[]> {
      const byName = new Map<string, CheckStatusLite>();
      const runs = await octokit.paginate(octokit.checks.listForRef, {
        owner,
        repo,
        ref: sha,
        per_page: 100,
      });
      for (const checkRun of runs) {
        byName.set(checkRun.name, {
          name: checkRun.name,
          status:
            checkRun.status === null ? "completed" : (checkRun.status as CheckStatusLite["status"]),
          conclusion: checkRun.conclusion as CheckStatusLite["conclusion"],
          summary: checkRun.output?.summary ?? checkRun.output?.title ?? undefined,
          detailsUrl: checkRun.details_url ?? undefined,
        });
      }
      // Legacy commit statuses only fill contexts not already covered by a check run.
      try {
        const { data } = await octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha });
        for (const status of data.statuses) {
          if (byName.has(status.context)) continue;
          byName.set(status.context, {
            name: status.context,
            status: status.state === "pending" ? "in_progress" : "completed",
            conclusion:
              status.state === "success"
                ? "success"
                : status.state === "pending"
                  ? null
                  : "failure",
            summary: status.description ?? undefined,
            detailsUrl: status.target_url ?? undefined,
          });
        }
      } catch {
        // combined status is best-effort; check runs alone are enough to gate
      }
      return [...byName.values()];
    },
    async getFailedCheckLogs(check): Promise<string | undefined> {
      const match = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(check.detailsUrl ?? "");
      if (match === null) return check.summary ?? undefined;
      try {
        const response = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id: Number(match[1]),
        });
        const text =
          typeof response.data === "string" ? response.data : String(response.data ?? "");
        const trimmed = text.trim();
        if (trimmed === "") return check.summary ?? undefined;
        return trimmed.length <= CHECK_LOG_MAX
          ? trimmed
          : `...(truncated)...\n${trimmed.slice(-CHECK_LOG_MAX)}`;
      } catch {
        return check.summary ?? undefined;
      }
    },
    async createIssueComment(issueNumber, body) {
      await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    },
    async getPullRequestForBranch(branch: string): Promise<PullRequestLite | undefined> {
      // Read-only: list every PR for this head branch (a branch may have an old
      // merged/closed PR alongside a newer open one) and reduce to a single
      // liveness verdict, preferring an open PR, then a merged one, then a
      // closed-unmerged one. `head` is `owner:branch` (fixowl always pushes to
      // the same repo).
      const prs = await octokit.paginate(octokit.pulls.list, {
        owner,
        repo,
        head: `${owner}:${branch}`,
        state: "all",
        per_page: 100,
      });
      const open = prs.find((pr) => pr.state === "open");
      if (open !== undefined) return { number: open.number, state: "OPEN" };
      const merged = prs.find((pr) => pr.merged_at !== null && pr.merged_at !== undefined);
      if (merged !== undefined) return { number: merged.number, state: "MERGED" };
      const [closed] = prs;
      return closed === undefined ? undefined : { number: closed.number, state: "CLOSED" };
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
