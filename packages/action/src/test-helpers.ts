import { readdirSync } from "node:fs";
import type { CheckStatusLite, RequiredChecks, WorkflowRunLite } from "@fixowl/core";
import type { Clock } from "./ci-poll.ts";
import type {
  ArtifactUploader,
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

/**
 * Instant clock for the CI wait: advances by whatever it is asked to sleep, so
 * the poll loop (and its fallback settle window) resolves in logical time with
 * no real delay. Inject as `NightDeps.clock` / `IssuePipelineDeps.clock`.
 */
export function instantClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

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
  /** PR numbers flipped ready-for-review, in order. */
  readyForReview: number[] = [];
  /**
   * The base branch's required checks. Default: unreadable, so the CI-gated
   * loop falls back to gating on all checks (see getChecksForRef).
   */
  requiredChecks: RequiredChecks = { readable: false, contexts: [] };
  /**
   * Checks on a head SHA, resolved per call so tests can vary them across
   * attempts. Default: none - with the default unreadable required set this is
   * a vacuous green, so a night with no CI opens ready-for-review PRs.
   */
  checksForRef: (sha: string) => CheckStatusLite[] = () => [];
  /** Failure detail for a red check; default none. */
  failedLogs: (check: CheckStatusLite) => string | undefined = () => undefined;
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

  async ensurePullRequest(params: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }> {
    const existing = this.pulls.find((pull) => pull.head === params.head);
    if (existing !== undefined) {
      return { number: existing.number, url: this.prUrl(existing.number) };
    }
    const number = ++this.nextPrNumber;
    this.pulls.push({ number, ...params });
    return { number, url: this.prUrl(number) };
  }

  async markPullRequestReadyForReview(prNumber: number): Promise<void> {
    this.readyForReview.push(prNumber);
    const pull = this.pulls.find((candidate) => candidate.number === prNumber);
    if (pull !== undefined) pull.draft = false;
  }

  async updatePullRequestBody(prNumber: number, body: string): Promise<void> {
    const pull = this.pulls.find((candidate) => candidate.number === prNumber);
    if (pull !== undefined) pull.body = body;
  }

  async getRequiredChecks(): Promise<RequiredChecks> {
    return this.requiredChecks;
  }

  async getChecksForRef(sha: string): Promise<CheckStatusLite[]> {
    return this.checksForRef(sha);
  }

  async getFailedCheckLogs(check: CheckStatusLite): Promise<string | undefined> {
    return this.failedLogs(check);
  }

  async createIssueComment(issueNumber: number, body: string): Promise<void> {
    this.comments.push({ issueNumber, body });
  }

  async listRecentWorkflowRuns(): Promise<WorkflowRunLite[]> {
    return this.workflowRuns;
  }

  private prUrl(number: number): string {
    return `https://github.com/test/repo/pull/${number}`;
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

/**
 * Records the progressive per-issue evidence uploads the night makes. Mirrors the
 * real uploader's "nothing to upload for an empty/missing dir" contract by
 * reading the directory, so a wiring test sees exactly the artifacts a real run
 * would create. `failFor` makes chosen artifact names throw, to prove an upload
 * failure stays best-effort and never aborts the night.
 */
export class FakeArtifactUploader implements ArtifactUploader {
  uploads: Array<{ name: string; dir: string }> = [];

  constructor(private readonly failFor: Set<string> = new Set()) {}

  async uploadDirectory(params: { name: string; dir: string }): Promise<boolean> {
    if (this.failFor.has(params.name)) {
      throw new Error(`simulated upload failure for ${params.name}`);
    }
    let entries: string[];
    try {
      entries = readdirSync(params.dir);
    } catch {
      return false;
    }
    if (entries.length === 0) return false;
    this.uploads.push({ name: params.name, dir: params.dir });
    return true;
  }
}
