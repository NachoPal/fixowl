import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerRunSpec, Exec, ExecResult, IssueLite } from "./deps.ts";
import { renderSummary, runNight, wipeoutFailure, type NightInputs } from "./main.ts";
import type { IssueResult } from "./issue-pipeline.ts";
import { realExec } from "./real-exec.ts";
import { FakeEngine, FakeGitHub, instantClock, issue, ok, silentLog } from "./test-helpers.ts";

/**
 * In-process integration of the whole night: real git (temp bare origin +
 * workspace clone), fake GitHub API, fake container engine that "edits" the
 * workspace the way an agent would.
 */

function resultRow(number: number, status: IssueResult["status"]): IssueResult {
  return {
    issue: issue(number, `#${number}`, "x"),
    branch: `issue/${number}`,
    status,
    verification: [],
  };
}

function summarizeWipeout(results: IssueResult[]): string | undefined {
  return wipeoutFailure({ results, skipped: [], deferred: [], warnings: [] });
}

async function git(cwd: string, ...argv: string[]): Promise<string> {
  const result = await realExec.run(
    [
      "git",
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...argv,
    ],
    { cwd },
  );
  if (result.code !== 0) throw new Error(`git ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

interface Setup {
  originDir: string;
  workspaceDir: string;
  tempDir: string;
  inputs: NightInputs;
}

async function setup(fixowlYml?: string): Promise<Setup> {
  const root = mkdtempSync(join(tmpdir(), "fixowl-night-"));
  const originDir = join(root, "origin.git");
  const seedDir = join(root, "seed");
  const workspaceDir = join(root, "workspace");
  const tempDir = join(root, "runner-temp");

  await git(root, "init", "--bare", "-b", "main", originDir);
  await git(root, "init", "-b", "main", seedDir);
  writeFileSync(join(seedDir, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(seedDir, "app.txt"), "v1\n");
  writeFileSync(
    join(seedDir, ".fixowl.yml"),
    fixowlYml ?? "version: 1\nverify:\n  checks:\n    - { name: tests, run: 'true' }\n",
  );
  await git(seedDir, "add", "-A");
  await git(seedDir, "commit", "-m", "seed");
  await git(seedDir, "remote", "add", "origin", originDir);
  await git(seedDir, "push", "origin", "main");
  await git(root, "clone", originDir, workspaceDir);

  const inputs: NightInputs = {
    repoFullName: "test/repo",
    defaultBranch: "main",
    labels: { any: ["overnight"] },
    agentName: "script",
    maxIssues: 4,
    issueTimeoutMinutes: 1,
    // Existing behavior tests exercise Layer 2 (the heuristic classifier), which
    // is opt-in and off by default; enable it here. The default-off path has its
    // own dedicated tests below.
    heuristicConflictOrdering: true,
    workspaceDir,
    tempDir,
    runUrl: "https://github.com/test/repo/actions/runs/1",
    env: {},
  };
  return { originDir, workspaceDir, tempDir, inputs };
}

function issueNumberOfAgentRun(spec: ContainerRunSpec): number | undefined {
  const match = /-(\d+)-agent$/.exec(spec.name);
  return match ? Number(match[1]) : undefined;
}

/** Engine whose "agent" writes one file per issue; override per-issue or classify behavior as needed. */
function makeEngine(options: {
  workspaceDir: string;
  failAgentFor?: number[];
  silentAgentFor?: number[];
  failCheck?: boolean;
  classifyOutput?: string;
}): FakeEngine {
  return new FakeEngine((spec): ExecResult | undefined => {
    if (spec.name.includes("-classify-")) {
      return ok(options.classifyOutput ?? "");
    }
    const issueNumber = issueNumberOfAgentRun(spec);
    if (issueNumber !== undefined) {
      if (options.failAgentFor?.includes(issueNumber)) {
        return { code: 1, stdout: "", stderr: "agent exploded", timedOut: false };
      }
      if (!options.silentAgentFor?.includes(issueNumber)) {
        writeFileSync(
          join(options.workspaceDir, `fix-${issueNumber}.txt`),
          `fixed ${issueNumber}\n`,
        );
      }
      return ok("done");
    }
    // verification check containers
    return options.failCheck
      ? { code: 1, stdout: "", stderr: "1 test failed", timedOut: false }
      : ok();
  });
}

async function remoteBranches(originDir: string): Promise<string[]> {
  const out = await git(originDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/");
  return out.split("\n").filter((line) => line !== "");
}

/** Pushes an in-flight issue branch (main + one marker file) to origin, as a prior night would. */
async function pushInFlightBranch(
  originDir: string,
  branch: string,
  marker: string,
): Promise<void> {
  const parent = mkdtempSync(join(tmpdir(), "fixowl-inflight-"));
  const dir = join(parent, "clone");
  await git(parent, "clone", originDir, dir);
  await git(dir, "checkout", "-b", branch);
  writeFileSync(join(dir, marker), "prereq work\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", `work for ${branch}`);
  await git(dir, "push", "origin", branch);
}

const threeIssues: IssueLite[] = [
  issue(1, "Fix header", "the header is wrong"),
  issue(2, "Fix footer", "the footer is wrong"),
  issue(3, "Fix sidebar", "the sidebar is wrong"),
];

// Usage reads go through the injected httpJson edge; this fake returns a chosen
// utilization fraction (0..1) per call so the pure gate logic decides trip/no-trip.
function usageFetcher(utilizationByCall: (call: number) => number): {
  httpJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
  calls: () => number;
} {
  let call = 0;
  return {
    calls: () => call,
    async httpJson() {
      call += 1;
      return { five_hour: { utilization: utilizationByCall(call), resets_at: 0 } };
    },
  };
}

/** A claude run whose issues stay independent, so the gate ordering is what's under test. */
function claudeBudgetInputs(inputs: NightInputs): NightInputs {
  return {
    ...inputs,
    agentName: "claude",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    heuristicConflictOrdering: false,
  };
}

async function throwingHttpJson(): Promise<unknown> {
  throw new Error("usage endpoint down");
}

describe("runNight", () => {
  it("three independent issues become three PRs off main", async () => {
    const { originDir, workspaceDir, tempDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({
      workspaceDir,
      classifyOutput: '{"chains": [[1], [2], [3]]}',
    });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );

    expect(summary.results.map((r) => r.status)).toEqual(["pr-opened", "pr-opened", "pr-opened"]);
    expect(github.pulls.map((pr) => [pr.head, pr.base, pr.draft])).toEqual([
      ["issue/1-fix-header", "main", false],
      ["issue/2-fix-footer", "main", false],
      ["issue/3-fix-sidebar", "main", false],
    ]);
    expect(github.pulls[0]?.title).toBe("fix #1: Fix header");
    expect(github.pulls[0]?.body).toContain("Closes #1.");
    expect(github.comments.map((c) => c.issueNumber)).toEqual([1, 2, 3]);

    const branches = await remoteBranches(originDir);
    expect(branches).toContain("issue/1-fix-header");
    expect(branches).toContain("issue/2-fix-footer");
    expect(branches).toContain("issue/3-fix-sidebar");

    const commitMessage = await git(originDir, "log", "-1", "--format=%s", "issue/1-fix-header");
    expect(commitMessage.trim()).toBe("fix #1: Fix header");

    expect(existsSync(join(tempDir, "fixowl-evidence", "issue-1", "agent-attempt-1.log"))).toBe(
      true,
    );
    expect(engine.builds).toHaveLength(1);
  });

  it("a rerun is a no-op: existing branches are the idempotency marker", async () => {
    const { originDir, workspaceDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2], [3]]}' });
    await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(github.pulls).toHaveLength(3);

    const secondRun = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(secondRun.results).toHaveLength(0);
    expect(secondRun.skipped.map((s) => s.issue.number)).toEqual([1, 2, 3]);
    expect(github.pulls).toHaveLength(3);
    expect(await remoteBranches(originDir)).toHaveLength(4); // main + 3 issue branches
  });

  it("one failing agent does not stop the other issues", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({
      workspaceDir,
      failAgentFor: [2],
      classifyOutput: '{"chains": [[1], [2], [3]]}',
    });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(summary.results.map((r) => [r.issue.number, r.status])).toEqual([
      [1, "pr-opened"],
      [2, "agent-failed"],
      [3, "pr-opened"],
    ]);
    expect(github.pulls.map((pr) => pr.head)).toEqual([
      "issue/1-fix-header",
      "issue/3-fix-sidebar",
    ]);
  });

  it("agent failure error carries a sanitized tail of the agent's real output", async () => {
    const { inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const rawOutput = `${"noise ".repeat(100)}\nline with a | pipe\nYou've hit your session limit · resets 6pm (UTC)`;
    const engine = new FakeEngine((spec): ExecResult | undefined => {
      if (issueNumberOfAgentRun(spec) === 1) {
        return { code: 1, stdout: "", stderr: rawOutput, timedOut: false };
      }
      return ok();
    });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    const result = summary.results[0];
    expect(result?.status).toBe("agent-failed");
    expect(result?.error).toContain("agent exited with code 1");
    expect(result?.error).toContain("You've hit your session limit");
    expect(result?.error).not.toContain("\n");
    expect(result?.error?.length ?? 0).toBeLessThan(400);
  });

  it("timeout error still reads clearly and includes the output tail", async () => {
    const { inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const engine = new FakeEngine((spec): ExecResult | undefined => {
      if (issueNumberOfAgentRun(spec) === 1) {
        return {
          code: 1,
          stdout: "stuck waiting on network | retrying",
          stderr: "",
          timedOut: true,
        };
      }
      return ok();
    });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    const result = summary.results[0];
    expect(result?.status).toBe("agent-failed");
    expect(result?.error).toMatch(/^agent timed out after \d+ms - /);
    expect(result?.error).toContain("stuck waiting on network \\| retrying");
  });

  it("failed verification opens a draft PR (work preserved)", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const engine = makeEngine({ workspaceDir, failCheck: true });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(summary.results[0]?.status).toBe("pr-opened");
    expect(summary.results[0]?.draft).toBe(true);
    expect(github.pulls[0]?.draft).toBe(true);
    expect(github.pulls[0]?.body).toContain("❌ failed");
    expect(github.comments[0]?.body).toContain("draft");
  });

  it("routes model/effort from selector labels and fails a multi-label issue loudly", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([
      issue(1, "Heavy fix", "x", ["overnight", "heavy"]),
      issue(2, "Ambiguous", "y", ["overnight", "heavy", "quick"]),
      issue(3, "Plain fix", "z", ["overnight"]),
    ]);
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2], [3]]}' });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      {
        ...inputs,
        agentName: "claude",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        defaultModel: "sonnet",
        defaultEffort: "medium",
        labelModels: {
          heavy: { model: "opus", effort: "max" },
          quick: { model: "haiku", effort: "low" },
        },
      },
    );

    const byNumber = new Map(summary.results.map((result) => [result.issue.number, result]));
    // The two-selector-label issue fails, loudly, and by itself.
    expect(byNumber.get(2)?.status).toBe("error");
    expect(byNumber.get(2)?.error).toMatch(/model-selector labels \(heavy, quick\)/);
    expect(engine.runs.some((spec) => spec.name.endsWith("-2-agent"))).toBe(false);
    // The other issues still open PRs.
    expect(byNumber.get(1)?.status).toBe("pr-opened");
    expect(byNumber.get(3)?.status).toBe("pr-opened");

    // The single-selector-label issue runs with that label's model/effort...
    const agent1 = engine.runs.find((spec) => spec.name.endsWith("-1-agent"));
    expect(agent1?.argv.join(" ")).toContain("--model opus --effort max");
    // ...and the unlabeled issue runs with the repo default.
    const agent3 = engine.runs.find((spec) => spec.name.endsWith("-3-agent"));
    expect(agent3?.argv.join(" ")).toContain("--model sonnet --effort medium");
  });

  it("an agent that changes nothing produces no PR and no branch", async () => {
    const { originDir, workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const engine = makeEngine({ workspaceDir, silentAgentFor: [1] });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(summary.results[0]?.status).toBe("no-changes");
    expect(github.pulls).toHaveLength(0);
    expect(await remoteBranches(originDir)).toEqual(["main"]);
  });

  it("a chain stacks: second PR targets the first branch and says so", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1, 2]]}' });

    await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([
      ["issue/1-fix-header", "main"],
      ["issue/2-fix-footer", "issue/1-fix-header"],
    ]);
    expect(github.pulls[1]?.body).toContain("Stacked on #101");

    // the child branch contains the parent's work
    const files = await git(workspaceDir, "ls-tree", "--name-only", "issue/2-fix-footer");
    expect(files).toContain("fix-1.txt");
    expect(files).toContain("fix-2.txt");
  });

  it("a failed mid-chain member is skipped over: the next bases on the default branch", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    const engine = makeEngine({
      workspaceDir,
      failAgentFor: [1],
      classifyOutput: '{"chains": [[1, 2]]}',
    });

    await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([["issue/2-fix-footer", "main"]]);
    expect(github.pulls[0]?.body).not.toContain("Stacked on");
  });

  it("classification garbage falls back to all-independent with a warning", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    const engine = makeEngine({ workspaceDir, classifyOutput: "no json here" });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(summary.warnings.some((w) => w.includes("classification"))).toBe(true);
    expect(github.pulls.map((pr) => pr.base)).toEqual(["main", "main"]);
  });

  it("classification runs against a read-only workspace with no single-issue shortcut skipped", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2]]}' });

    await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    const classifyRun = engine.runs.find((spec) => spec.name.includes("-classify-"));
    expect(classifyRun?.workspaceReadOnly).toBe(true);
  });

  describe("Layer 2 opt-in (heuristicConflictOrdering, default off)", () => {
    it("off (default): skips the classifier and treats every issue as independent", async () => {
      const { originDir, workspaceDir, inputs } = await setup();
      const github = new FakeGitHub(structuredClone(threeIssues));
      // A classifier output that WOULD stack #1 and #2 - ignored when off, and the
      // container must never run at all so its cost/latency is never spent.
      const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1, 2], [3]]}' });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        { ...inputs, heuristicConflictOrdering: false },
      );

      expect(engine.runs.some((spec) => spec.name.includes("-classify-"))).toBe(false);
      expect(summary.results.map((r) => r.status)).toEqual(["pr-opened", "pr-opened", "pr-opened"]);
      // Every PR bases off the default branch; no cross-issue stacking.
      expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([
        ["issue/1-fix-header", "main"],
        ["issue/2-fix-footer", "main"],
        ["issue/3-fix-sidebar", "main"],
      ]);
      expect(github.pulls.some((pr) => pr.body.includes("Stacked on"))).toBe(false);
      const branches = await remoteBranches(originDir);
      expect(branches).toContain("issue/1-fix-header");
      expect(branches).toContain("issue/2-fix-footer");
      expect(branches).toContain("issue/3-fix-sidebar");
    });

    it("off: undefined flag behaves as off (classifier skipped)", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
      const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1, 2]]}' });

      const { heuristicConflictOrdering: _omit, ...noFlag } = inputs;
      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        noFlag,
      );

      expect(engine.runs.some((spec) => spec.name.includes("-classify-"))).toBe(false);
      expect(github.pulls.map((pr) => pr.base)).toEqual(["main", "main"]);
      expect(summary.results.map((r) => r.status)).toEqual(["pr-opened", "pr-opened"]);
    });

    it("off: native blocked_by (Layer 1) still stacks a same-night dependent", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
      // #2 is natively blocked by #1; both ship tonight.
      github.dependencies.set(2, {
        number: 2,
        blockedBy: [{ number: 1, repo: "test/repo", state: "OPEN" }],
      });
      const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2]]}' });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        { ...inputs, heuristicConflictOrdering: false },
      );

      // Classifier never runs, yet the native edge still stacks #2 on #1.
      expect(engine.runs.some((spec) => spec.name.includes("-classify-"))).toBe(false);
      expect(summary.deferred).toEqual([]);
      expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([
        ["issue/1-fix-header", "main"],
        ["issue/2-fix-footer", "issue/1-fix-header"],
      ]);
      expect(github.pulls[1]?.body).toContain("Stacked on #101");
    });
  });

  describe("layered run budgets (issue #21)", () => {
    it("pre-run gate: an over-budget usage window stands the whole night down", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub(structuredClone(threeIssues));
      const engine = makeEngine({ workspaceDir });
      const { httpJson } = usageFetcher(() => 0.9); // 90% >= 50% budget

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, httpJson },
        { ...claudeBudgetInputs(inputs), usageBudgetPercent: 50 },
      );

      expect(summary.results).toEqual([]);
      expect(github.pulls).toHaveLength(0);
      expect(engine.runs.some((spec) => spec.name.endsWith("-agent"))).toBe(false);
      expect(summary.budgetStop?.condition).toBe("usage");
      expect(summary.notStarted?.map((i) => i.number)).toEqual([1, 2, 3]);
      expect(renderSummary("test/repo", summary)).toContain("## Run stopped early (usage budget)");
    });

    it("between-issues gate: stops the run once usage crosses the budget mid-night", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub(structuredClone(threeIssues));
      const engine = makeEngine({ workspaceDir });
      // Pre-run read + the gate before issue #1 read low; the gate before #2 reads high.
      const { httpJson } = usageFetcher((call) => (call >= 3 ? 0.9 : 0.1));

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, httpJson, clock: instantClock() },
        { ...claudeBudgetInputs(inputs), usageBudgetPercent: 50 },
      );

      expect(summary.results.map((r) => [r.issue.number, r.status])).toEqual([[1, "pr-opened"]]);
      expect(github.pulls.map((pr) => pr.head)).toEqual(["issue/1-fix-header"]);
      expect(summary.budgetStop?.condition).toBe("usage");
      expect(summary.notStarted?.map((i) => i.number)).toEqual([2, 3]);
    });

    it("usage read that abstains falls through to the other budgets, with one warning", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub(structuredClone(threeIssues));
      const engine = makeEngine({ workspaceDir });
      // Every read fails: advisory, so the night proceeds (bounded by count).
      const summary = await runNight(
        {
          github,
          engine,
          exec: realExec,
          log: silentLog,
          httpJson: throwingHttpJson,
          clock: instantClock(),
        },
        { ...claudeBudgetInputs(inputs), usageBudgetPercent: 50 },
      );

      expect(summary.results.map((r) => r.status)).toEqual(["pr-opened", "pr-opened", "pr-opened"]);
      expect(summary.budgetStop).toBeUndefined();
      expect(summary.warnings.filter((w) => w.includes("unobservable"))).toHaveLength(1);
    });

    it("no usage budget set: the usage endpoint is never read", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub(structuredClone(threeIssues));
      const engine = makeEngine({ workspaceDir });
      const fetcher = usageFetcher(() => 0.99);

      const summary = await runNight(
        {
          github,
          engine,
          exec: realExec,
          log: silentLog,
          httpJson: fetcher.httpJson,
          clock: instantClock(),
        },
        claudeBudgetInputs(inputs), // usageBudgetPercent left undefined
      );

      expect(fetcher.calls()).toBe(0);
      expect(summary.results.map((r) => r.status)).toEqual(["pr-opened", "pr-opened", "pr-opened"]);
    });
  });

  it("respects max_issues_per_run", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2]]}' });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      { ...inputs, maxIssues: 2 },
    );
    expect(summary.results.map((r) => r.issue.number)).toEqual([1, 2]);
    expect(github.pulls).toHaveLength(2);
  });

  it("the agent container gets only allowlisted env and the workspace mount", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const engine = makeEngine({ workspaceDir });

    await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      { ...inputs, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-x", FAL_KEY: "paid", GITHUB_TOKEN: "gh" } },
    );
    const agentRun = engine.runs.find((spec) => issueNumberOfAgentRun(spec) === 1);
    expect(agentRun?.env).toEqual({}); // script adapter allowlists nothing
    // prompt file is the only extra mount for a file-prompt adapter
    expect(agentRun?.extraMounts?.map((m) => m.container)).toEqual(["/fixowl/prompt.md"]);
  });

  it("containers see a git-less workspace; a planted .git is inert and never reaches the host", async () => {
    const { originDir, workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    const hookMarker = join(workspaceDir, "hook-ran-on-host.txt");
    const engine = new FakeEngine((spec): ExecResult | undefined => {
      if (spec.name.includes("-classify-")) {
        expect(existsSync(join(workspaceDir, ".git"))).toBe(false);
        return ok('{"chains": [[1], [2]]}');
      }
      const issueNumber = issueNumberOfAgentRun(spec);
      if (issueNumber === undefined) return ok(); // verification containers
      // The invariant: no agent container ever sees a git dir in the workspace.
      expect(existsSync(join(workspaceDir, ".git"))).toBe(false);
      if (issueNumber === 1) {
        // Hostile agent: plant a .git with a hook and hostile config, hoping
        // host git will execute them during status/add/commit/push.
        mkdirSync(join(workspaceDir, ".git", "hooks"), { recursive: true });
        writeFileSync(
          join(workspaceDir, ".git", "hooks", "pre-commit"),
          `#!/bin/sh\ntouch ${hookMarker}\n`,
          {
            mode: 0o755,
          },
        );
        writeFileSync(
          join(workspaceDir, ".git", "config"),
          `[core]\n\tfsmonitor = touch ${hookMarker}\n`,
        );
      }
      writeFileSync(join(workspaceDir, `fix-${issueNumber}.txt`), `fixed ${issueNumber}\n`);
      return ok("done");
    });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );

    expect(summary.results.map((r) => r.status)).toEqual(["pr-opened", "pr-opened"]);
    // Neither the planted hook nor fsmonitor ever executed on the host.
    expect(existsSync(hookMarker)).toBe(false);
    // The planted .git was never committed or pushed.
    const files = await git(originDir, "ls-tree", "-r", "--name-only", "issue/1-fix-header");
    expect(files).toContain("fix-1.txt");
    expect(files).not.toContain("pre-commit");
    // After the night, the real git dir is restored and the planted one is gone.
    const restoredConfig = readFileSync(join(workspaceDir, ".git", "config"), "utf8");
    expect(restoredConfig).not.toContain("fsmonitor");
    expect(existsSync(join(workspaceDir, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("the push token never lands in argv or the mounted workspace", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const engine = makeEngine({ workspaceDir });
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const spyExec: Exec = {
      run(argv, options) {
        calls.push({ argv: [...argv], env: options?.env });
        return realExec.run(argv, options);
      },
    };
    const token = "ghp_FAKE_sekret_token";

    const summary = await runNight(
      { github, engine, exec: spyExec, log: silentLog, clock: instantClock() },
      { ...inputs, pushToken: token },
    );
    expect(summary.results[0]?.status).toBe("pr-opened");

    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    for (const call of calls) {
      // Neither the raw token nor its base64 form may ever hit argv (`ps`).
      expect(call.argv.join(" ")).not.toContain("sekret");
      expect(call.argv.join(" ")).not.toContain(basic);
    }
    // The workspace (bind-mounted into untrusted containers) must stay clean.
    const gitConfig = readFileSync(join(workspaceDir, ".git", "config"), "utf8");
    expect(gitConfig).not.toContain("sekret");
    expect(gitConfig).not.toContain(basic);
    // The credential travels only as an env-injected http.extraheader.
    const pushCall = calls.find((call) => call.argv[0] === "git" && call.argv.includes("push"));
    expect(pushCall?.env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${basic}`);
  });

  it("fails the whole night only for batch-level problems (missing agent creds)", async () => {
    const { inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const engine = makeEngine({ workspaceDir: inputs.workspaceDir });

    await expect(
      runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        { ...inputs, agentName: "claude", env: {} },
      ),
    ).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("wipeoutFailure: red only when work was attempted and every issue failed", () => {
    // Total wipeout: every attempted issue failed, nothing shipped -> red.
    const wipeout = summarizeWipeout([resultRow(1, "agent-failed"), resultRow(6, "error")]);
    expect(wipeout).toBeDefined();
    expect(wipeout).toContain("#1, #6");

    // Nothing to do tonight (no matching issues) -> green.
    expect(summarizeWipeout([])).toBeUndefined();
    // A partial night with at least one PR opened -> green.
    expect(summarizeWipeout([resultRow(1, "pr-opened"), resultRow(6, "error")])).toBeUndefined();
    // A benign no-change outcome is not a failure -> green.
    expect(summarizeWipeout([resultRow(1, "no-changes")])).toBeUndefined();
    expect(summarizeWipeout([resultRow(1, "no-changes"), resultRow(6, "error")])).toBeUndefined();
  });

  it("renders a readable summary", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({
      workspaceDir,
      failAgentFor: [2],
      classifyOutput: '{"chains": [[1], [2], [3]]}',
    });
    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    const markdown = renderSummary("test/repo", summary);
    expect(markdown).toContain("# 🦉 fixowl night run: test/repo");
    expect(markdown).toContain("#1 Fix header");
    expect(markdown).toContain("agent-failed");
    expect(markdown).toContain("tests: passed");
  });

  it("a native prerequisite forces stacking even when the LLM calls the issues independent", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    // #2 is blocked by #1; both selected and open.
    github.dependencies.set(2, {
      number: 2,
      blockedBy: [{ number: 1, repo: "test/repo", state: "OPEN" }],
    });
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2]]}' });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(summary.deferred).toEqual([]);
    expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([
      ["issue/1-fix-header", "main"],
      ["issue/2-fix-footer", "issue/1-fix-header"],
    ]);
    expect(github.pulls[1]?.body).toContain("Stacked on #101");
  });

  it("defers a dependent whose blocker is not in tonight's set: no PR, no agent run", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(2, "Fix footer", "y")]);
    // #2 is blocked by #1, which is not selected tonight.
    github.dependencies.set(2, {
      number: 2,
      blockedBy: [{ number: 1, repo: "test/repo", state: "OPEN" }],
    });
    const engine = makeEngine({ workspaceDir });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(summary.results).toEqual([]);
    expect(github.pulls).toHaveLength(0);
    expect(engine.runs.some((spec) => spec.name.endsWith("-2-agent"))).toBe(false);
    expect(summary.deferred.map((d) => d.issue.number)).toEqual([2]);
    expect(renderSummary("test/repo", summary)).toContain("## Deferred");
  });

  it("defers the dependent when its prerequisite fails to ship (not rebase-to-default)", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    github.dependencies.set(2, {
      number: 2,
      blockedBy: [{ number: 1, repo: "test/repo", state: "OPEN" }],
    });
    // The prerequisite #1's agent fails.
    const engine = makeEngine({
      workspaceDir,
      failAgentFor: [1],
      classifyOutput: '{"chains": [[1], [2]]}',
    });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    // #1 was attempted and failed; #2 is deferred, never attempted, no PR (contrast
    // the conflict-chain case where the downstream member rebases onto main).
    expect(summary.results.map((r) => [r.issue.number, r.status])).toEqual([[1, "agent-failed"]]);
    expect(summary.deferred.map((d) => d.issue.number)).toEqual([2]);
    expect(github.pulls).toHaveLength(0);
    expect(engine.runs.some((spec) => spec.name.endsWith("-2-agent"))).toBe(false);
  });

  it("defers a whole dependency cycle and ships the rest", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    // #1 <-> #2 cycle; #3 is independent.
    github.dependencies.set(1, {
      number: 1,
      blockedBy: [{ number: 2, repo: "test/repo", state: "OPEN" }],
    });
    github.dependencies.set(2, {
      number: 2,
      blockedBy: [{ number: 1, repo: "test/repo", state: "OPEN" }],
    });
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[3]]}' });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
      inputs,
    );
    expect(summary.results.map((r) => r.issue.number)).toEqual([3]);
    expect(github.pulls.map((pr) => pr.head)).toEqual(["issue/3-fix-sidebar"]);
    expect(summary.deferred.map((d) => d.issue.number).toSorted()).toEqual([1, 2]);
    expect(summary.warnings.some((w) => w.includes("cycle"))).toBe(true);
  });

  describe("in-flight stacking base (issue #48)", () => {
    it("stacks a fresh dependent on a skipped prerequisite whose PR is open", async () => {
      const { originDir, workspaceDir, inputs } = await setup();
      // #1's branch is in flight from a prior night (open PR); #2 is fresh and
      // natively blocked by #1.
      await pushInFlightBranch(originDir, "issue/1-fix-header", "fix-1.txt");
      const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
      github.dependencies.set(2, {
        number: 2,
        blockedBy: [{ number: 1, repo: "test/repo", state: "OPEN" }],
      });
      github.pullsByBranch.set("issue/1-fix-header", { number: 101, state: "OPEN" });
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        inputs,
      );

      // #1 stays skipped (in flight, not re-run); #2 ships stacked on #1's branch.
      expect(summary.skipped.map((s) => s.issue.number)).toEqual([1]);
      expect(summary.deferred).toEqual([]);
      expect(engine.runs.some((spec) => spec.name.endsWith("-1-agent"))).toBe(false);
      expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([
        ["issue/2-fix-footer", "issue/1-fix-header"],
      ]);
      expect(github.pulls[0]?.body).toContain("Stacked on #101");
      // The dependent branch carries the prerequisite's already-pushed work.
      const files = await git(workspaceDir, "ls-tree", "-r", "--name-only", "issue/2-fix-footer");
      expect(files).toContain("fix-1.txt");
      expect(files).toContain("fix-2.txt");
    });

    it("bases from the default branch once the prerequisite PR is merged (not stacked)", async () => {
      const { originDir, workspaceDir, inputs } = await setup();
      await pushInFlightBranch(originDir, "issue/1-fix-header", "fix-1.txt");
      const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
      github.dependencies.set(2, {
        number: 2,
        blockedBy: [{ number: 1, repo: "test/repo", state: "OPEN" }],
      });
      github.pullsByBranch.set("issue/1-fix-header", { number: 101, state: "MERGED" });
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        inputs,
      );

      expect(summary.deferred).toEqual([]);
      expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([
        ["issue/2-fix-footer", "main"],
      ]);
      expect(github.pulls[0]?.body).not.toContain("Stacked on");
    });

    it("defers rather than stacking on an abandoned (closed-unmerged) prerequisite PR", async () => {
      const { originDir, workspaceDir, inputs } = await setup();
      await pushInFlightBranch(originDir, "issue/1-fix-header", "fix-1.txt");
      const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
      github.dependencies.set(2, {
        number: 2,
        blockedBy: [{ number: 1, repo: "test/repo", state: "OPEN" }],
      });
      github.pullsByBranch.set("issue/1-fix-header", { number: 101, state: "CLOSED" });
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        inputs,
      );

      expect(summary.results).toEqual([]);
      expect(github.pulls).toHaveLength(0);
      expect(summary.deferred.map((d) => d.issue.number)).toEqual([2]);
      expect(engine.runs.some((spec) => spec.name.endsWith("-2-agent"))).toBe(false);
    });

    it("never stacks across nights without a native edge (heuristic path unchanged)", async () => {
      const { originDir, workspaceDir, inputs } = await setup();
      // #1 is in flight with an open PR, but #2 carries NO native blocked_by edge.
      await pushInFlightBranch(originDir, "issue/1-fix-header", "fix-1.txt");
      const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
      github.pullsByBranch.set("issue/1-fix-header", { number: 101, state: "OPEN" });
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        inputs,
      );

      expect(summary.skipped.map((s) => s.issue.number)).toEqual([1]);
      expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([
        ["issue/2-fix-footer", "main"],
      ]);
      expect(github.pulls[0]?.body).not.toContain("Stacked on");
    });
  });

  describe("scheduled-slot budget guard", () => {
    it("stands a scheduled-slot run down when an earlier slot run already covered today", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x")]);
      github.workflowRuns = [
        {
          id: 100,
          event: "schedule",
          status: "in_progress",
          createdAt: new Date().toISOString(),
          displayTitle: "fixowl night run",
        },
      ];
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        { ...inputs, scheduledSlot: true, currentRunId: 200 },
      );

      // No work happened: no PRs, no agent containers, a clean no-op.
      expect(github.pulls).toEqual([]);
      expect(engine.runs).toEqual([]);
      expect(summary.results).toEqual([]);
      expect(summary.warnings.some((w) => w.includes("already covered"))).toBe(true);
    });

    it("proceeds for the first scheduled-slot run of the day", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x")]);
      // Only this run exists today; it is the earliest slot run.
      github.workflowRuns = [
        {
          id: 200,
          event: "schedule",
          status: "in_progress",
          createdAt: new Date().toISOString(),
          displayTitle: "fixowl night run",
        },
      ];
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        { ...inputs, scheduledSlot: true, currentRunId: 200 },
      );
      expect(summary.results[0]?.status).toBe("pr-opened");
    });

    it("never guards a plain manual dispatch, even when a slot run already ran today", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x")]);
      github.workflowRuns = [
        {
          id: 100,
          event: "schedule",
          status: "completed",
          createdAt: new Date().toISOString(),
          displayTitle: "fixowl night run",
        },
      ];
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        { ...inputs, scheduledSlot: false, currentRunId: 300 },
      );
      expect(summary.results[0]?.status).toBe("pr-opened");
    });
  });

  describe("CI-gated fix loop", () => {
    it("retries a red required check and opens a ready PR once it goes green", async () => {
      const { workspaceDir, tempDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x")]);
      github.requiredChecks = { readable: true, contexts: ["ci"] };
      let ciCalls = 0;
      github.checksForRef = () => {
        ciCalls++;
        return [
          {
            name: "ci",
            status: "completed",
            conclusion: ciCalls === 1 ? "failure" : "success",
            summary: "bundle is stale",
            detailsUrl: "https://github.com/test/repo/actions/runs/1/job/2",
          },
        ];
      };
      github.failedLogs = () => "dist/ is stale; run pnpm build";
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        inputs,
      );

      expect(summary.results[0]?.status).toBe("pr-opened");
      expect(summary.results[0]?.draft).toBe(false);
      // One PR, created on the first push and reused across attempts.
      expect(github.pulls).toHaveLength(1);
      expect(github.pulls[0]?.draft).toBe(false);
      expect(github.readyForReview).toContain(github.pulls[0]?.number);
      expect(ciCalls).toBe(2);
      expect(github.comments[0]?.body).toContain("ready for review");
      // The retry prompt carried the CI failure, fenced and with the fetched log.
      const prompt = readFileSync(join(tempDir, "fixowl-prompts", "issue-1.md"), "utf8");
      expect(prompt).toContain("<untrusted-ci-output>");
      expect(prompt).toContain("dist/ is stale");
      expect(engine.runs.filter((s) => s.name.endsWith("-1-agent"))).toHaveLength(2);
    });

    it("leaves an annotated draft PR when the required checks stay red", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x")]);
      github.requiredChecks = { readable: true, contexts: ["ci"] };
      github.checksForRef = () => [
        { name: "ci", status: "completed", conclusion: "failure", summary: "still failing" },
      ];
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        { ...inputs, ciMaxTries: 2 },
      );

      expect(summary.results[0]?.status).toBe("pr-opened");
      expect(summary.results[0]?.draft).toBe(true);
      expect(github.pulls).toHaveLength(1);
      expect(github.pulls[0]?.draft).toBe(true);
      expect(github.readyForReview).toEqual([]);
      expect(github.comments[0]?.body).toContain("draft");
      expect(github.pulls[0]?.body).toContain("still red");
      expect(engine.runs.filter((s) => s.name.endsWith("-1-agent"))).toHaveLength(2);
    });

    it("a failing local pre-check short-circuits: no push and no CI call", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x")]);
      let ciCalls = 0;
      github.checksForRef = () => {
        ciCalls++;
        return [];
      };
      const engine = makeEngine({ workspaceDir, failCheck: true });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        { ...inputs, ciMaxTries: 2 },
      );

      // CI is never consulted while the local pre-check is red.
      expect(ciCalls).toBe(0);
      // The work still lands as a draft for the human, annotated with the local failure.
      expect(summary.results[0]?.status).toBe("pr-opened");
      expect(summary.results[0]?.draft).toBe(true);
      expect(github.pulls).toHaveLength(1);
      expect(github.readyForReview).toEqual([]);
      expect(github.pulls[0]?.body).toContain("❌ failed");
      expect(engine.runs.filter((s) => s.name.endsWith("-1-agent"))).toHaveLength(2);
    });

    it("gates only on required checks; a failing non-required check does not block", async () => {
      const { workspaceDir, inputs } = await setup();
      const github = new FakeGitHub([issue(1, "Fix header", "x")]);
      github.requiredChecks = { readable: true, contexts: ["ci"] };
      github.checksForRef = () => [
        { name: "ci", status: "completed", conclusion: "success" },
        { name: "lint", status: "completed", conclusion: "failure" },
      ];
      const engine = makeEngine({ workspaceDir });

      const summary = await runNight(
        { github, engine, exec: realExec, log: silentLog, clock: instantClock() },
        inputs,
      );
      expect(summary.results[0]?.status).toBe("pr-opened");
      expect(summary.results[0]?.draft).toBe(false);
      expect(github.pulls[0]?.draft).toBe(false);
    });
  });
});
