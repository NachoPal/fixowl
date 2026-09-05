/**
 * Local end-to-end of a whole night against a REAL Docker engine: real git
 * (bare origin in a temp dir), real image build, real hardened `docker run`s
 * with the `script` adapter, fake GitHub API. Zero LLM spend, zero network
 * writes. Run with: pnpm e2e:docker (requires a running Docker engine).
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerEngine } from "../packages/action/src/container-exec.ts";
import type { GitHubApi, IssueLite, Logger } from "../packages/action/src/deps.ts";
import { renderSummary, runNight } from "../packages/action/src/main.ts";
import { realExec } from "../packages/action/src/real-exec.ts";

const log: Logger = {
  info: (message) => console.log(`[info] ${message}`),
  warn: (message) => console.warn(`[warn] ${message}`),
  error: (message) => console.error(`[error] ${message}`),
};

async function git(cwd: string, ...argv: string[]): Promise<string> {
  const result = await realExec.run(
    [
      "git",
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@test",
      "-c",
      "commit.gpgsign=false",
      ...argv,
    ],
    { cwd },
  );
  if (result.code !== 0) throw new Error(`git ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const root = mkdtempSync(join(tmpdir(), "fixowl-docker-e2e-"));
console.log(`sandbox: ${root}`);
const originDir = join(root, "origin.git");
const seedDir = join(root, "seed");
const workspaceDir = join(root, "workspace");
const tempDir = join(root, "runner-temp");
mkdirSync(tempDir, { recursive: true });

await git(root, "init", "--bare", "-b", "main", originDir);
await git(root, "init", "-b", "main", seedDir);
writeFileSync(join(seedDir, "Dockerfile"), "FROM debian:bookworm-slim\n");
writeFileSync(join(seedDir, "app.txt"), "hello\n");
writeFileSync(
  join(seedDir, ".fixowl.yml"),
  [
    "version: 1",
    "verify:",
    "  checks:",
    '    - { name: fix-landed, run: "test -f fix-1.txt && grep -q fixed-by-script fix-1.txt" }',
  ].join("\n") + "\n",
);
await git(seedDir, "add", "-A");
await git(seedDir, "commit", "-m", "seed");
await git(seedDir, "remote", "add", "origin", originDir);
await git(seedDir, "push", "origin", "main");
await git(root, "clone", originDir, workspaceDir);

// The body doubles as the reviewer's exploit suite: it snapshots what the
// untrusted container can see of .git/config (must be nothing: the git dir is
// extracted for the night), then plants a hostile .git - a pre-commit hook and
// a core.fsmonitor command - hoping host git will execute them during
// status/add/commit/push. We assert below that none of it ever runs.
const issues: IssueLite[] = [
  {
    number: 1,
    title: "Create the fix file",
    body: [
      "cat .git/config > seen-git-config.txt 2>&1 || echo 'NO .git IN WORKSPACE' > seen-git-config.txt",
      "mkdir -p .git/hooks",
      "printf '#!/bin/sh\\ntouch hook-ran-on-host.txt\\n' > .git/hooks/pre-commit",
      "chmod +x .git/hooks/pre-commit",
      "printf '[core]\\n\\tfsmonitor = touch hook-ran-on-host.txt\\n' > .git/config",
      "echo fixed-by-script > fix-1.txt",
    ].join("\n"),
    labels: ["overnight"],
  },
];
const FAKE_PUSH_TOKEN = "ghp_FAKE_e2e_runtime_token";
const pulls: Array<{ head: string; base: string; title: string; draft: boolean; body: string }> =
  [];
const comments: Array<{ issueNumber: number; body: string }> = [];
const github: GitHubApi = {
  async listOpenIssuesWithLabels() {
    return issues;
  },
  async createPullRequest(params) {
    pulls.push(params);
    return { number: 500, url: "https://example.test/pull/500" };
  },
  async createIssueComment(issueNumber, body) {
    comments.push({ issueNumber, body });
  },
  async getIssueDependencies(numbers) {
    return new Map(numbers.map((n) => [n, { number: n, blockedBy: [] }]));
  },
  async getPullRequestForBranch() {
    return undefined;
  },
  async listRecentWorkflowRuns() {
    return [];
  },
};

const summary = await runNight(
  { github, engine: new DockerEngine(realExec, log), exec: realExec, log },
  {
    repoFullName: "local/e2e",
    defaultBranch: "main",
    labels: { any: ["overnight"] },
    agentName: "script",
    maxIssues: 4,
    issueTimeoutMinutes: 3,
    workspaceDir,
    tempDir,
    pushToken: FAKE_PUSH_TOKEN,
    env: {},
  },
);

console.log("\n" + renderSummary("local/e2e", summary));

assert.equal(summary.results.length, 1);
assert.equal(summary.results[0]?.status, "pr-opened");
assert.equal(summary.results[0]?.verification[0]?.status, "passed");
assert.equal(pulls.length, 1);
assert.equal(pulls[0]?.head, "issue/1-create-the-fix-file");
assert.equal(pulls[0]?.base, "main");
assert.equal(pulls[0]?.draft, false);
assert.equal(comments.length, 1);

const branches = await git(originDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/");
assert.ok(branches.includes("issue/1-create-the-fix-file"), "branch pushed to origin");
const fileOnBranch = await git(workspaceDir, "show", "issue/1-create-the-fix-file:fix-1.txt");
assert.equal(fileOnBranch.trim(), "fixed-by-script");
// The exploit view: everything the agent container could read of .git/config.
// With the git dir extracted for the night there must be nothing to read.
const seenConfig = await git(
  workspaceDir,
  "show",
  "issue/1-create-the-fix-file:seen-git-config.txt",
);
assert.ok(seenConfig.includes("NO .git IN WORKSPACE"), "agent container saw a .git dir");
assert.ok(!seenConfig.includes(FAKE_PUSH_TOKEN), "runtime PAT leaked into the agent container");
assert.ok(
  !seenConfig.includes(Buffer.from(`x-access-token:${FAKE_PUSH_TOKEN}`).toString("base64")),
  "runtime PAT (base64) leaked into the agent container",
);
// The planted .git never executed on the host and never reached the branch.
assert.ok(
  !existsSync(join(workspaceDir, "hook-ran-on-host.txt")),
  "a planted git hook or fsmonitor command executed on the host",
);
const branchFiles = await git(
  workspaceDir,
  "ls-tree",
  "-r",
  "--name-only",
  "issue/1-create-the-fix-file",
);
assert.ok(!branchFiles.includes("pre-commit"), "the planted .git was committed");
// After the night the real git dir is back and free of the planted config.
const restoredConfig = readFileSync(join(workspaceDir, ".git", "config"), "utf8");
assert.ok(!restoredConfig.includes("fsmonitor"), "planted config survived the restore");
assert.ok(!restoredConfig.includes(FAKE_PUSH_TOKEN), "runtime PAT leaked into .git/config");
assert.ok(existsSync(join(tempDir, "fixowl-evidence", "issue-1", "agent.log")));
assert.ok(
  readFileSync(
    join(tempDir, "fixowl-evidence", "issue-1", "check-fix-landed.log"),
    "utf8",
  ).includes("exit 0"),
);

console.log(
  "\n✓ local docker e2e passed: real image build, hardened container run, verify, push, PR",
);
