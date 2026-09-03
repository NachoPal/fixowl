import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerRunSpec, Exec, ExecResult, IssueLite } from "./deps.ts";
import { renderSummary, runNight, type NightInputs } from "./main.ts";
import { realExec } from "./real-exec.ts";
import { FakeEngine, FakeGitHub, issue, ok, silentLog } from "./test-helpers.ts";

/**
 * In-process integration of the whole night: real git (temp bare origin +
 * workspace clone), fake GitHub API, fake container engine that "edits" the
 * workspace the way an agent would.
 */

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
    workspaceDir,
    tempDir,
    runUrl: "https://github.com/test/repo/actions/runs/1",
    env: {},
  };
  return { originDir, workspaceDir, tempDir, inputs };
}

function issueNumberOfAgentRun(spec: ContainerRunSpec): number | undefined {
  const match = /^fixowl-(\d+)-agent$/.exec(spec.name);
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
    if (spec.name.startsWith("fixowl-classify-")) {
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

const threeIssues: IssueLite[] = [
  issue(1, "Fix header", "the header is wrong"),
  issue(2, "Fix footer", "the footer is wrong"),
  issue(3, "Fix sidebar", "the sidebar is wrong"),
];

describe("runNight", () => {
  it("three independent issues become three PRs off main", async () => {
    const { originDir, workspaceDir, tempDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({
      workspaceDir,
      classifyOutput: '{"chains": [[1], [2], [3]]}',
    });

    const summary = await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);

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

    expect(existsSync(join(tempDir, "fixowl-evidence", "issue-1", "agent.log"))).toBe(true);
    expect(engine.builds).toHaveLength(1);
  });

  it("a rerun is a no-op: existing branches are the idempotency marker", async () => {
    const { originDir, workspaceDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2], [3]]}' });
    await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
    expect(github.pulls).toHaveLength(3);

    const secondRun = await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
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

    const summary = await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
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

  it("failed verification opens a draft PR (work preserved)", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const engine = makeEngine({ workspaceDir, failCheck: true });

    const summary = await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
    expect(summary.results[0]?.status).toBe("pr-opened");
    expect(summary.results[0]?.draft).toBe(true);
    expect(github.pulls[0]?.draft).toBe(true);
    expect(github.pulls[0]?.body).toContain("❌ failed");
    expect(github.comments[0]?.body).toContain("draft");
  });

  it("an agent that changes nothing produces no PR and no branch", async () => {
    const { originDir, workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x")]);
    const engine = makeEngine({ workspaceDir, silentAgentFor: [1] });

    const summary = await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
    expect(summary.results[0]?.status).toBe("no-changes");
    expect(github.pulls).toHaveLength(0);
    expect(await remoteBranches(originDir)).toEqual(["main"]);
  });

  it("a chain stacks: second PR targets the first branch and says so", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1, 2]]}' });

    await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
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

    await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
    expect(github.pulls.map((pr) => [pr.head, pr.base])).toEqual([["issue/2-fix-footer", "main"]]);
    expect(github.pulls[0]?.body).not.toContain("Stacked on");
  });

  it("classification garbage falls back to all-independent with a warning", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    const engine = makeEngine({ workspaceDir, classifyOutput: "no json here" });

    const summary = await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
    expect(summary.warnings.some((w) => w.includes("classification"))).toBe(true);
    expect(github.pulls.map((pr) => pr.base)).toEqual(["main", "main"]);
  });

  it("classification runs against a read-only workspace with no single-issue shortcut skipped", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub([issue(1, "Fix header", "x"), issue(2, "Fix footer", "y")]);
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2]]}' });

    await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
    const classifyRun = engine.runs.find((spec) => spec.name.startsWith("fixowl-classify-"));
    expect(classifyRun?.workspaceReadOnly).toBe(true);
  });

  it("respects max_issues_per_run", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({ workspaceDir, classifyOutput: '{"chains": [[1], [2]]}' });

    const summary = await runNight(
      { github, engine, exec: realExec, log: silentLog },
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
      { github, engine, exec: realExec, log: silentLog },
      { ...inputs, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-x", FAL_KEY: "paid", GITHUB_TOKEN: "gh" } },
    );
    const agentRun = engine.runs.find((spec) => issueNumberOfAgentRun(spec) === 1);
    expect(agentRun?.env).toEqual({}); // script adapter allowlists nothing
    // prompt file is the only extra mount for a file-prompt adapter
    expect(agentRun?.extraMounts?.map((m) => m.container)).toEqual(["/fixowl/prompt.md"]);
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
      { github, engine, exec: spyExec, log: silentLog },
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
        { github, engine, exec: realExec, log: silentLog },
        { ...inputs, agentName: "claude", env: {} },
      ),
    ).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("renders a readable summary", async () => {
    const { workspaceDir, inputs } = await setup();
    const github = new FakeGitHub(structuredClone(threeIssues));
    const engine = makeEngine({
      workspaceDir,
      failAgentFor: [2],
      classifyOutput: '{"chains": [[1], [2], [3]]}',
    });
    const summary = await runNight({ github, engine, exec: realExec, log: silentLog }, inputs);
    const markdown = renderSummary("test/repo", summary);
    expect(markdown).toContain("# 🦉 fixowl night run: test/repo");
    expect(markdown).toContain("#1 Fix header");
    expect(markdown).toContain("agent-failed");
    expect(markdown).toContain("tests: passed");
  });
});
