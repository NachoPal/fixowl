import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROMPT_MOUNT_PATH,
  type AgentAdapter,
  type ModelSelection,
  type RepoFileConfig,
} from "@fixowl/core";
import { containerName } from "./container-exec.ts";
import type { ContainerEngine, ContainerMount, GitHubApi, IssueLite, Logger } from "./deps.ts";
import type { GitWorkspace } from "./git-ops.ts";
import { anyCheckFailed, buildPrBody, buildPrTitle, type CheckOutcome } from "./pr-body.ts";
import { buildFixPrompt } from "./prompt-builder.ts";
import { runVerification } from "./verification.ts";

export interface IssuePipelineDeps {
  git: GitWorkspace;
  engine: ContainerEngine;
  github: GitHubApi;
  log: Logger;
}

export interface IssueRunContext {
  issue: IssueLite;
  branch: string;
  /** Git ref the branch is created from (e.g. "origin/main" or a parent issue branch). */
  baseRef: string;
  /** Branch name the PR targets. */
  prBase: string;
  stackedOn?: { prNumber: number; branch: string };
  image: string;
  repoFullName: string;
  repoConfig: RepoFileConfig;
  adapter: AgentAdapter;
  /** Resolved allowlisted env values for the agent container. */
  agentEnv: Record<string, string>;
  /** Model/effort resolved for this issue; empty fields fall through to the CLI default. */
  selection: ModelSelection;
  workspaceDir: string;
  promptDir: string;
  evidenceDir: string;
  timeoutMs: number;
  runUrl?: string;
}

export interface IssueResult {
  issue: IssueLite;
  branch: string;
  status: "pr-opened" | "no-changes" | "agent-failed" | "error";
  prNumber?: number;
  prUrl?: string;
  draft?: boolean;
  verification: CheckOutcome[];
  error?: string;
}

export async function processIssue(
  deps: IssuePipelineDeps,
  ctx: IssueRunContext,
): Promise<IssueResult> {
  const { git, engine, github, log } = deps;
  const { issue, branch } = ctx;
  const base: Omit<IssueResult, "status"> = { issue, branch, verification: [] };

  mkdirSync(ctx.evidenceDir, { recursive: true });
  mkdirSync(ctx.promptDir, { recursive: true });

  log.info(`issue #${issue.number}: branching ${branch} from ${ctx.baseRef}`);
  await git.checkoutNewBranch(branch, ctx.baseRef);

  const prompt = buildFixPrompt({ issue, repoConfig: ctx.repoConfig });
  const promptFile = join(ctx.promptDir, `issue-${issue.number}.md`);
  writeFileSync(promptFile, prompt);

  const extraMounts: ContainerMount[] = [];
  let stdin: string | undefined;
  if (ctx.adapter.promptVia === "file") {
    extraMounts.push({ host: promptFile, container: PROMPT_MOUNT_PATH, readOnly: true });
  } else {
    stdin = prompt;
  }

  log.info(`issue #${issue.number}: running agent "${ctx.adapter.name}"`);
  const agentResult = await engine.run({
    image: ctx.image,
    name: containerName(ctx.repoFullName, issue.number, "agent"),
    workspaceDir: ctx.workspaceDir,
    argv: ctx.adapter.argv("fix", ctx.selection),
    env: ctx.agentEnv,
    extraMounts,
    stdin,
    timeoutMs: ctx.timeoutMs,
  });
  writeFileSync(
    join(ctx.evidenceDir, "agent.log"),
    `${agentResult.stdout}\n${agentResult.stderr}\n(exit ${agentResult.code}${agentResult.timedOut ? ", timed out" : ""})\n`,
  );

  if (agentResult.timedOut || agentResult.code !== 0) {
    await git.discardAllChanges();
    return {
      ...base,
      status: "agent-failed",
      error: agentResult.timedOut
        ? `agent timed out after ${ctx.timeoutMs}ms`
        : `agent exited with code ${agentResult.code}`,
    };
  }

  if (!(await git.hasChangesAgainst(ctx.baseRef))) {
    log.warn(`issue #${issue.number}: agent finished but produced no changes`);
    return { ...base, status: "no-changes" };
  }

  const verification = await runVerification({
    engine,
    log,
    image: ctx.image,
    workspaceDir: ctx.workspaceDir,
    evidenceDir: ctx.evidenceDir,
    repoFullName: ctx.repoFullName,
    issueNumber: issue.number,
    verify: ctx.repoConfig.verify,
  });

  const title = buildPrTitle(issue.number, issue.title);
  await git.commitAll(title);
  await git.push(branch);

  const draft = anyCheckFailed(verification);
  const pr = await github.createPullRequest({
    head: branch,
    base: ctx.prBase,
    title,
    body: buildPrBody({
      issueNumber: issue.number,
      verification,
      stackedOn: ctx.stackedOn,
      runUrl: ctx.runUrl,
    }),
    draft,
  });
  log.info(`issue #${issue.number}: opened PR #${pr.number}${draft ? " (draft)" : ""}`);

  await github.createIssueComment(
    issue.number,
    `🦉 fixowl opened ${pr.url} for this issue${draft ? " as a draft (verification failed; see the PR)" : ""}.`,
  );

  return { ...base, status: "pr-opened", prNumber: pr.number, prUrl: pr.url, draft, verification };
}
