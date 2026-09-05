import type { Octokit } from "@octokit/rest";
import type { CheckStatusLite, ChecksForRef, RequiredChecks } from "@fixowl/core";
import type { GitHubApi, IssueDeps, IssueLite, PullRequestLite } from "./deps.ts";

/** The GitHub-API edge of the action: the real `GitHubApi` implementation. */

/** Longest job-log tail fetched for a red check before the prompt fence caps it further. */
const CHECK_LOG_MAX = 6000;

/** Shape of the `parameters` on a branch-rules `required_status_checks` rule. */
interface RequiredStatusChecksParameters {
  required_status_checks?: Array<{ context: string; integration_id?: number }>;
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

/**
 * True when a GitHub read failed because the token is not allowed to make it -
 * the check-runs API needs a "Checks" permission GitHub does not expose to
 * fine-grained PATs, so a fine-grained runtime token 403s ("Resource not
 * accessible by personal access token"). We degrade the CI gate on this class
 * only; any other failure (network, 5xx) still propagates.
 */
export function isNotAccessibleError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === 403 || status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not accessible/i.test(message);
}

/**
 * @param octokit runtime-PAT client for issues/PRs (the night's write path).
 * @param runsOctokit client with Actions: read (the ephemeral GITHUB_TOKEN) for
 *   the scheduled-slot guard's runs query; undefined disables the guard's fetch.
 */
export function makeGitHubApi(
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
    async getChecksForRef(sha): Promise<ChecksForRef> {
      const byName = new Map<string, CheckStatusLite>();
      // Reading check runs needs a "Checks" permission GitHub does not expose to
      // fine-grained PATs, so a fine-grained runtime token 403s here. Treat that
      // as "checks unreadable" (mirrors getRequiredChecks) so the poll loop
      // degrades to the settle-then-ready fallback instead of failing the issue.
      const runs = await octokit
        .paginate(octokit.checks.listForRef, { owner, repo, ref: sha, per_page: 100 })
        .catch((error: unknown) => {
          if (isNotAccessibleError(error)) return undefined;
          throw error;
        });
      if (runs === undefined) return { readable: false, checks: [] };
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
      return { readable: true, checks: [...byName.values()] };
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
