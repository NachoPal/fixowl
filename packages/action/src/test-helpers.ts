import type {
  ContainerEngine,
  ContainerRunSpec,
  ExecResult,
  GitHubApi,
  IssueLite,
  Logger,
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
  private nextPrNumber = 100;

  constructor(public issues: IssueLite[]) {}

  async listOpenIssuesWithLabels(labelsQuery: string): Promise<IssueLite[]> {
    const required = labelsQuery.split(",");
    return this.issues.filter((candidate) =>
      required.every((label) => candidate.labels.includes(label)),
    );
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
