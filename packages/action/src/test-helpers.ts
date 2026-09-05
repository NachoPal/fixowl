import type { WorkflowRunLite } from "@fixowl/core";
import type {
  ContainerEngine,
  ContainerRunSpec,
  ExecResult,
  GitHubApi,
  IssueDeps,
  IssueLite,
  Logger,
  PullRequestLite,
} from "./deps.ts";

export const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

export function fail(code = 1, stderr = "boom"): ExecResult {
  return { code, stdout: "", stderr, timedOut: false };
}

export interface CreatedPull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export class FakeGitHub implements GitHubApi {
  pulls: CreatedPull[] = [];
  comments: Array<{ issueNumber: number; body: string }> = [];
  /** Native dependency edges keyed by issue number; empty means no edges (today's behavior). */
  dependencies: Map<number, IssueDeps> = new Map();
  /** PR liveness keyed by head branch, for the in-flight stacking-base lookup (issue #48). */
  pullsByBranch: Map<string, PullRequestLite> = new Map();
  /** Recent workflow runs the scheduled-slot guard sees; empty by default. */
  workflowRuns: WorkflowRunLite[] = [];
  private nextPrNumber = 100;

  constructor(public issues: IssueLite[]) {}

  async listOpenIssuesWithLabels(labelsQuery: string): Promise<IssueLite[]> {
    const required = labelsQuery.split(",");
    return this.issues.filter((candidate) =>
      required.every((label) => candidate.labels.includes(label)),
    );
  }

  async getIssueDependencies(numbers: readonly number[]): Promise<Map<number, IssueDeps>> {
    const result = new Map<number, IssueDeps>();
    for (const n of numbers) {
      result.set(n, this.dependencies.get(n) ?? { number: n, blockedBy: [] });
    }
    return result;
  }

  async getPullRequestForBranch(branch: string): Promise<PullRequestLite | undefined> {
    return this.pullsByBranch.get(branch);
  }

  async createPullRequest(params: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }> {
    const number = ++this.nextPrNumber;
    this.pulls.push({ number, ...params });
    return { number, url: `https://github.com/test/repo/pull/${number}` };
  }

  async createIssueComment(issueNumber: number, body: string): Promise<void> {
    this.comments.push({ issueNumber, body });
  }

  async listRecentWorkflowRuns(): Promise<WorkflowRunLite[]> {
    return this.workflowRuns;
  }
}

/**
 * Container engine fake. `onRun` receives every spec; return an ExecResult to
 * control the outcome, or undefined for a default success. Simulate the agent
 * editing the workspace by doing fs writes inside `onRun`.
 */
export class FakeEngine implements ContainerEngine {
  builds: Array<{ image: string; dockerfile: string; contextDir: string }> = [];
  runs: ContainerRunSpec[] = [];

  constructor(
    private readonly onRun: (
      spec: ContainerRunSpec,
    ) => Promise<ExecResult | undefined> | ExecResult | undefined = () => undefined,
    private readonly onBuild: () => ExecResult = () => ok(),
  ) {}

  async build(params: {
    image: string;
    dockerfile: string;
    contextDir: string;
  }): Promise<ExecResult> {
    this.builds.push(params);
    return this.onBuild();
  }

  async run(spec: ContainerRunSpec): Promise<ExecResult> {
    this.runs.push(spec);
    return (await this.onRun(spec)) ?? ok();
  }
}

export function issue(number: number, title: string, body = "", labels = ["overnight"]): IssueLite {
  return { number, title, body, labels };
}
