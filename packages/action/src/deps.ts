/**
 * Every side effect of the night run goes through these interfaces, so the
 * whole flow can run in-process against fakes (and the sandbox e2e can run the
 * real thing with the `script` adapter and zero LLM spend).
 */

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
  createPullRequest(params: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }>;
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
