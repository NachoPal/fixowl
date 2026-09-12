/**
 * Every side effect of the night run goes through these interfaces, so the
 * whole flow can run in-process against fakes (and the sandbox e2e can run the
 * real thing with the `script` adapter and zero LLM spend).
 */

import type { CheckStatusLite, ChecksForRef, RequiredChecks, WorkflowRunLite } from "@fixowl/core";

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

/** A pull request (or issue) reference fixowl links in a triage-skip comment. */
export interface TriageRef {
  number: number;
  url: string;
}

/**
 * A pull request's mergeability, as GitHub reports it. `mergeable` is `null`
 * while GitHub is still computing it (the first read after a push kicks off the
 * computation), so callers poll until it is known. `state` is the
 * `mergeable_state` string (`clean`/`dirty`/`behind`/`blocked`/`unstable`/...);
 * `dirty` means real merge conflicts. Read-only; the pure `classifyMergeability`
 * turns this into a gate action.
 */
export interface PullRequestMergeState {
  mergeable: boolean | null;
  state: string;
}

/**
 * The pre-work triage signals GitHub exposes for one OPEN issue (Layer A), read
 * read-only in one aliased GraphQL round-trip. All fields are high-precision:
 * they mean GitHub itself recorded the relationship. A bare merged-PR
 * cross-reference (no closing keyword) is deliberately NOT surfaced here - it is
 * ambiguous, so it is left for Layer B (the agent verifies against the code).
 */
export interface IssueTriageSignals {
  number: number;
  /**
   * A merged PR in THIS repo that closes the issue via a closing keyword
   * (GitHub's `closedByPullRequestsReferences`, or a `willCloseTarget`
   * cross-reference from a merged PR). Present => already fixed.
   */
  fixedByMergedPr?: TriageRef;
  /**
   * The canonical original when GitHub records the issue as a duplicate (the
   * latest `MarkedAsDuplicateEvent` not undone by a later unmark). Present =>
   * duplicate.
   */
  duplicateOf?: TriageRef;
}

export interface GitHubApi {
  /** One GitHub "list issues" call; `labelsQuery` is the comma-joined AND query. Returns issues only, never PRs. */
  listOpenIssuesWithLabels(labelsQuery: string): Promise<IssueLite[]>;
  /**
   * One BOUNDED page of open issues matching the comma-joined AND `labelsQuery`,
   * oldest-first (`sort=created&direction=asc`). Unlike `listOpenIssuesWithLabels`
   * this does NOT auto-paginate: the caller drives paging (priority selection pages
   * tier-by-tier, stopping once the cap is filled), so the fetch is O(cap), not the
   * whole backlog. `issues` holds the PR-filtered survivors (issues only, never
   * PRs); `fetched` is the RAW count GitHub returned for the page BEFORE PR
   * filtering (issues + PRs). Exhaustion is signalled by a short RAW page
   * (`fetched < perPage`), NOT the filtered length - `listForRepo` intermixes PRs,
   * so a full GitHub page carrying a PR yields fewer issues than perPage without the
   * query being drained. See priority-selection.ts and docs/priority-selection.md.
   */
  listOpenIssuesPage(
    labelsQuery: string,
    opts: { page: number; perPage: number },
  ): Promise<{ issues: IssueLite[]; fetched: number }>;
  /**
   * Read-only triage signals for the candidate issues (Layer A), in one aliased
   * GraphQL round-trip (the `getIssueDependencies` technique). An empty map (or a
   * number missing from it) means "no confident signal" - never a skip. Never
   * writes. See triage.ts and docs/issue-triage.md.
   */
  getIssueTriageSignals(numbers: readonly number[]): Promise<Map<number, IssueTriageSignals>>;
  /**
   * Apply labels to an issue (Issues: write, already held by the runtime App).
   * Used to stamp the `fixowl:triaged` marker on a triaged-out issue so it drops
   * out of the next night's candidate set. Best-effort at the call site.
   */
  addLabels(issueNumber: number, labels: readonly string[]): Promise<void>;
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
   * Read-only mergeability of a pull request (Pull requests: read, already held),
   * used by the CI-gated loop to detect a conflicted (`dirty`) PR before waiting
   * on required checks that a dirty PR's uncomputable merge ref can never
   * complete. `mergeable` is `null` while GitHub computes it (poll until known).
   * Never writes; fail-open (returns `{ mergeable: null, state: "unknown" }` on a
   * read error) so an unreadable state never aborts the night. See conflict-gate.ts.
   */
  getPullRequestMergeState(prNumber: number): Promise<PullRequestMergeState>;
  /**
   * Recent runs of this workflow, newest first, for the scheduled-slot budget
   * guard. Backed by a token with Actions: read (the ephemeral `GITHUB_TOKEN`,
   * not the App token), so listing runs never widens the most-exposed
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
   * statuses, normalized to `CheckStatusLite` and de-duplicated by name. Returns
   * `readable: false` (never throws) when the runtime credential cannot read the
   * check-runs API - an App installation missing Checks: read is 403'd; the CI
   * gate then degrades to the settle-then-ready fallback instead of failing the
   * issue (captain 7.2).
   */
  getChecksForRef(sha: string): Promise<ChecksForRef>;
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
