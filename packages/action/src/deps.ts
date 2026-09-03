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

export interface GitHubApi {
  /** One GitHub "list issues" call; `labelsQuery` is the comma-joined AND query. Returns issues only, never PRs. */
  listOpenIssuesWithLabels(labelsQuery: string): Promise<IssueLite[]>;
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
