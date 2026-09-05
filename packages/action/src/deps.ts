/**
 * Every side effect of the night run goes through these interfaces, so the
 * whole flow can run in-process against fakes (and the sandbox e2e can run the
 * real thing with the `script` adapter and zero LLM spend).
 */

import type { CheckStatusLite, RequiredChecks, WorkflowRunLite } from "@fixowl/core";

export interface IssueLite {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

/** One native GitHub issue-dependency edge target (from a `blockedBy` connection). */
export interface EdgeRef {
  number: number;
  /** `owner/repo` of the target issue, to detect cross-repo blockers. */
  repo: string;
  state: "OPEN" | "CLOSED";
}

/** The native prerequisite edges of one selected issue (Layer 1 input). */
export interface IssueDeps {
  number: number;
  /** Issues that must ship before this one; a closed target is already satisfied. */
  blockedBy: EdgeRef[];
  /** True when the issue has more blockers than were fetched (>50); forces a conservative defer. */
  blockedByOverflow?: boolean;
}

/**
 * One pull request's liveness, used to gate whether an idempotency-skipped
 * prerequisite branch is a live stacking base (issue #48). `OPEN` = in flight
 * (a live base to stack on); `MERGED` = already in the base branch (disregard,
 * base from default); `CLOSED` = closed unmerged, i.e. abandoned (disregard,
 * never stack on abandoned work).
 */
export interface PullRequestLite {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
}

export interface GitHubApi {
  /** One GitHub "list issues" call; `labelsQuery` is the comma-joined AND query. Returns issues only, never PRs. */
  listOpenIssuesWithLabels(labelsQuery: string): Promise<IssueLite[]>;
  /**
   * Read-only fetch of the native `blockedBy` dependency edges for the given
   * issue numbers, in one aliased GraphQL round-trip. Layer-1 planner input;
   * an empty result means the night behaves exactly as it did before dep-graph
   * awareness. Never writes edges (see the propose-and-confirm decision, off).
   */
  getIssueDependencies(numbers: readonly number[]): Promise<Map<number, IssueDeps>>;
  /**
   * Read-only lookup of the pull request whose head is `branch`, used to gate
   * whether an idempotency-skipped prerequisite is still in flight before
   * stacking a dependent on its branch (issue #48). Prefers an open PR, then a
   * merged one, then a closed-unmerged one; undefined when the branch has no PR.
   * Never writes (see the no-merge invariant).
   */
  getPullRequestForBranch(branch: string): Promise<PullRequestLite | undefined>;
  /**
   * Recent runs of this workflow, newest first, for the scheduled-slot budget
   * guard. Backed by a token with Actions: read (the ephemeral `GITHUB_TOKEN`,
   * not the runtime PAT), so listing runs never widens the most-exposed
   * credential. Returns an empty list when no read token is available.
   */
  listRecentWorkflowRuns(): Promise<WorkflowRunLite[]>;
  /**
   * Create the issue's PR if it does not exist yet, otherwise return the open
   * one for `head`. The CI-gated loop creates one draft PR on the first push
   * and reuses it across attempts (later pushes just advance its head SHA), so
   * this is idempotent by design.
   */
  ensurePullRequest(params: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }>;
  /** Flip a draft PR to ready-for-review once its required checks are green. */
  markPullRequestReadyForReview(prNumber: number): Promise<void>;
  /** Update an existing PR's body (e.g. to record the outstanding CI failures). */
  updatePullRequestBody(prNumber: number, body: string): Promise<void>;
  /**
   * The required status-check contexts GitHub enforces for `baseBranch` (branch
   * protection or ruleset), read via the branch-rules endpoint. Unreadable or
   * empty results (`readable: false`) make the loop fall back to gating on all
   * completed checks; it never fails loud (captain 7.2).
   */
  getRequiredChecks(baseBranch: string): Promise<RequiredChecks>;
  /**
   * All checks on a commit: GitHub Actions check runs plus legacy commit
   * statuses, normalized to `CheckStatusLite` and de-duplicated by name.
   */
  getChecksForRef(sha: string): Promise<CheckStatusLite[]>;
  /**
   * Best-effort failure detail for a red check - the failing job's log tail
   * (bounded) or the check's own summary - to feed back to the agent. CI logs
   * are untrusted, so callers fence and length-cap the result.
   */
  getFailedCheckLogs(check: CheckStatusLite): Promise<string | undefined>;
  createIssueComment(issueNumber: number, body: string): Promise<void>;
  // Deliberately no merge capability. See no-merge.test.ts.
}

export interface ExecOptions {
  cwd?: string;
  /** Extra env vars, merged over the parent process env by real implementations. */
  env?: Record<string, string>;
  stdin?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Exec {
  /** Spawns argv directly, never through a shell. */
  run(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ContainerMount {
  host: string;
  container: string;
  readOnly?: boolean;
}

export interface ContainerRunSpec {
  image: string;
  argv: readonly string[];
  /** Unique container name; the timeout path uses it for `docker rm -f`. */
  name: string;
  workspaceDir: string;
  workspaceReadOnly?: boolean;
  /**
   * `uid:gid` the container process runs as (docker `--user`). Set to the host
   * runner's uid/gid so the coding agent runs non-root (required by the Claude
   * CLI's `--dangerously-skip-permissions`) while still owning the bind-mounted
   * workspace on Linux hosts. Undefined leaves docker's default (root).
   */
  user?: string;
  /**
   * Writable HOME for the container process. A `--user` uid with no
   * `/etc/passwd` entry needs an explicit, writable HOME or tools that look up
   * the current user (npm, git, pnpm) break. Rendered as `-e HOME=<homeDir>`.
   */
  homeDir?: string;
  /** Allowlisted env vars entering the container. Nothing else does. */
  env?: Record<string, string>;
  extraMounts?: ContainerMount[];
  stdin?: string;
  timeoutMs?: number;
}

export interface ContainerEngine {
  build(params: { image: string; dockerfile: string; contextDir: string }): Promise<ExecResult>;
  run(spec: ContainerRunSpec): Promise<ExecResult>;
  /** Best-effort removal of stale images in `repository`, keeping `keepImage`; the runner host's disk is finite. */
  pruneImages?(repository: string, keepImage: string): Promise<void>;
}

export interface ArtifactUploader {
  /**
   * Upload one directory as a named workflow-run artifact, from within the action
   * while the job is still running. Progressive per-issue upload (evidence on
   * cancel) relies on this: an artifact finalized mid-job survives a later job
   * cancellation, unlike the single end-of-job `upload-artifact` step, which a
   * cancelled job never reaches - the self-hosted runner reconnects only after
   * the job is already server-side "completed", so that upload 403s and all
   * evidence is lost.
   *
   * Returns true when an artifact was created, false when there was nothing to
   * upload (a missing or empty directory - e.g. an issue that never wrote
   * evidence). Any real upload failure is thrown so the caller can log it; the
   * caller keeps it best-effort and never lets it abort the night.
   */
  uploadDirectory(params: { name: string; dir: string }): Promise<boolean>;
}
