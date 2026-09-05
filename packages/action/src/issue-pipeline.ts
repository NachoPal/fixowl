import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROMPT_MOUNT_PATH,
  type AgentAdapter,
  type CheckStatusLite,
  type ModelSelection,
  type RepoFileConfig,
  type RequiredChecks,
} from "@fixowl/core";
import {
  realClock,
  waitForRequiredChecks,
  type Clock,
  type WaitForChecksResult,
} from "./ci-poll.ts";
import { containerName } from "./container-exec.ts";
import type { ContainerEngine, ContainerMount, GitHubApi, IssueLite, Logger } from "./deps.ts";
import type { GitWorkspace } from "./git-ops.ts";
import {
  anyCheckFailed,
  buildPrBody,
  buildPrTitle,
  type CheckOutcome,
  type CiCheckFailure,
  type CiGateSummary,
} from "./pr-body.ts";
import { buildFixPrompt, type CheckFailureFeedback } from "./prompt-builder.ts";
import { runVerification } from "./verification.ts";

export interface IssuePipelineDeps {
  git: GitWorkspace;
  engine: ContainerEngine;
  github: GitHubApi;
  log: Logger;
  /** Clock for the CI wait; defaults to the real one. Tests inject an instant clock. */
  clock?: Clock;
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
  /** Max agent passes in the CI-gated loop before a draft PR is left. */
  ciMaxTries: number;
  /** How long each pass waits for the pushed head's required checks. */
  ciTimeoutMs: number;
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

/** Longest agent output excerpt carried into a failure's `error` string. */
const AGENT_ERROR_EXCERPT_MAX = 300;

export function tail(text: string, max: number): string {
  return text.length <= max ? text : `...${text.slice(-max)}`;
}

/** Issue titles and agent output are untrusted/arbitrary text; keep them from breaking the summary's markdown tables. */
export function markdownCell(text: string): string {
  return text.replaceAll(/\s+/g, " ").replaceAll("|", "\\|").trim();
}

/**
 * Runs the CI-gated fix loop for one issue (Option A). After each agent pass:
 * a cheap local pre-check (`.fixowl.yml`) short-circuits before spending a CI
 * cycle on an obviously-broken change; when it passes, the change is pushed and
 * the target repo's *real* CI is the authority. Green required checks flip the
 * PR to ready-for-review; a red or timed-out attempt feeds the failures back to
 * the agent and tries again. When the budget is exhausted, a draft PR is left
 * annotated with the outstanding failures. fixowl never merges.
 */
export async function processIssue(
  deps: IssuePipelineDeps,
  ctx: IssueRunContext,
): Promise<IssueResult> {
  const { git, engine, github, log } = deps;
  const clock = deps.clock ?? realClock;
  const { issue, branch } = ctx;
  const base: Omit<IssueResult, "status"> = { issue, branch, verification: [] };

  mkdirSync(ctx.evidenceDir, { recursive: true });
  mkdirSync(ctx.promptDir, { recursive: true });

  log.info(`issue #${issue.number}: branching ${branch} from ${ctx.baseRef}`);
  await git.checkoutNewBranch(branch, ctx.baseRef);

  const title = buildPrTitle(issue.number, issue.title);
  const maxTries = ctx.ciMaxTries;

  let previousFailures: CheckFailureFeedback[] | undefined;
  let pr: { number: number; url: string } | undefined;
  let lastVerification: CheckOutcome[] = [];
  let lastCi: WaitForChecksResult | undefined;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const agentResult = await runAgent(deps, ctx, { attempt, previousFailures });

    if (agentResult.timedOut || agentResult.code !== 0) {
      // Unchanged agent-failed path: discard and stop. A provider limit or hard
      // crash surfaces here and terminates the run; the loop is not special-cased.
      await git.discardAllChanges();
      const reason = agentResult.timedOut
        ? `agent timed out after ${ctx.timeoutMs}ms`
        : `agent exited with code ${agentResult.code}`;
      const output = `${agentResult.stdout}\n${agentResult.stderr}`.trim();
      const excerpt = output.length > 0 ? markdownCell(tail(output, AGENT_ERROR_EXCERPT_MAX)) : "";
      return {
        ...base,
        status: "agent-failed",
        error: excerpt.length > 0 ? `${reason} - ${excerpt}` : reason,
      };
    }

    if (attempt === 1 && !(await git.hasChangesAgainst(ctx.baseRef))) {
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
    lastVerification = verification;

    // Cheap pre-filter: a change that cannot even pass the local smoke test
    // never reaches CI. Feed the local failures back and retry, no push.
    if (anyCheckFailed(verification)) {
      previousFailures = localFeedback(verification);
      log.info(
        `issue #${issue.number}: local pre-check failed (attempt ${attempt}/${maxTries}); not pushing`,
      );
      continue;
    }

    await git.commitAll(title);
    await git.push(branch);
    const headSha = await git.headSha();

    if (pr === undefined) {
      pr = await github.ensurePullRequest({
        head: branch,
        base: ctx.prBase,
        title,
        body: buildPrBody({
          issueNumber: issue.number,
          verification,
          stackedOn: ctx.stackedOn,
          runUrl: ctx.runUrl,
        }),
        draft: true,
      });
      log.info(`issue #${issue.number}: opened draft PR #${pr.number}`);
    }

    const required = await readRequiredChecks(github, ctx.prBase, log);
    log.info(
      `issue #${issue.number}: waiting for CI on ${headSha.slice(0, 12)} (attempt ${attempt}/${maxTries})`,
    );
    const ci = await waitForRequiredChecks(
      { github, log, clock },
      { sha: headSha, base: ctx.prBase, required, timeoutMs: ctx.ciTimeoutMs },
    );
    lastCi = ci;

    if (ci.outcome === "green") {
      await github.markPullRequestReadyForReview(pr.number);
      const summary: CiGateSummary = { state: "green", usedFallback: ci.usedFallback };
      await github.updatePullRequestBody(
        pr.number,
        buildPrBody({
          issueNumber: issue.number,
          verification,
          stackedOn: ctx.stackedOn,
          runUrl: ctx.runUrl,
          ci: summary,
        }),
      );
      log.info(`issue #${issue.number}: required checks green; PR #${pr.number} ready for review`);
      await github.createIssueComment(
        issue.number,
        `🦉 fixowl opened ${pr.url} for this issue; its required checks are green and it is ready for review.`,
      );
      return {
        ...base,
        status: "pr-opened",
        prNumber: pr.number,
        prUrl: pr.url,
        draft: false,
        verification,
      };
    }

    previousFailures = await ciFeedback(github, ci);
    log.info(
      `issue #${issue.number}: CI ${ci.timedOut ? "did not complete in time" : "is red"} ` +
        `(attempt ${attempt}/${maxTries})`,
    );
  }

  return finishExhausted(deps, ctx, { title, pr, lastVerification, lastCi });
}

/** Runs the agent container once, writing its output to the per-attempt evidence log. */
async function runAgent(
  deps: IssuePipelineDeps,
  ctx: IssueRunContext,
  params: { attempt: number; previousFailures: readonly CheckFailureFeedback[] | undefined },
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  const { engine, log } = deps;
  const { issue } = ctx;

  const prompt = buildFixPrompt({
    issue,
    repoConfig: ctx.repoConfig,
    previousFailures: params.previousFailures,
  });
  const promptFile = join(ctx.promptDir, `issue-${issue.number}.md`);
  writeFileSync(promptFile, prompt);

  const extraMounts: ContainerMount[] = [];
  let stdin: string | undefined;
  if (ctx.adapter.promptVia === "file") {
    extraMounts.push({ host: promptFile, container: PROMPT_MOUNT_PATH, readOnly: true });
  } else {
    stdin = prompt;
  }

  log.info(
    `issue #${issue.number}: running agent "${ctx.adapter.name}" (attempt ${params.attempt}/${ctx.ciMaxTries})`,
  );
  const result = await engine.run({
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
    join(ctx.evidenceDir, `agent-attempt-${params.attempt}.log`),
    `${result.stdout}\n${result.stderr}\n(exit ${result.code}${result.timedOut ? ", timed out" : ""})\n`,
  );
  return result;
}

/**
 * The try budget is spent. Leave a draft PR annotated with the outstanding
 * failures: reuse the PR opened during the loop (its head is the last CI-tested
 * push), or - if the local pre-check never passed so nothing was ever pushed -
 * push the last attempt's work and open the draft now so the human sees it.
 */
async function finishExhausted(
  deps: IssuePipelineDeps,
  ctx: IssueRunContext,
  state: {
    title: string;
    pr: { number: number; url: string } | undefined;
    lastVerification: CheckOutcome[];
    lastCi: WaitForChecksResult | undefined;
  },
): Promise<IssueResult> {
  const { git, github, log } = deps;
  const { issue } = ctx;
  const base: Omit<IssueResult, "status"> = { issue, branch: ctx.branch, verification: [] };
  log.warn(`issue #${issue.number}: exhausted ${ctx.ciMaxTries} attempt(s); leaving a draft PR`);

  let pr = state.pr;
  if (pr === undefined) {
    if (!(await git.hasChangesAgainst(ctx.baseRef))) {
      return { ...base, status: "no-changes", verification: state.lastVerification };
    }
    await git.commitAll(state.title);
    await git.push(ctx.branch);
  } else {
    // A PR already exists, so its head is the last CI-tested push. If the final
    // attempt failed the local pre-check, its changes were never committed;
    // discard them so the branch stays at the pushed commit and the working
    // tree is clean for the next chain member's checkout.
    await git.discardAllChanges();
  }

  const ci: CiGateSummary | undefined =
    state.lastCi !== undefined
      ? {
          state: "failed",
          reason: state.lastCi.timedOut ? "timeout" : "red",
          failures: state.lastCi.failed.map(toCiCheckFailure),
          usedFallback: state.lastCi.usedFallback,
        }
      : undefined;

  const body = buildPrBody({
    issueNumber: issue.number,
    verification: state.lastVerification,
    stackedOn: ctx.stackedOn,
    runUrl: ctx.runUrl,
    ci,
  });

  if (pr === undefined) {
    pr = await github.ensurePullRequest({
      head: ctx.branch,
      base: ctx.prBase,
      title: state.title,
      body,
      draft: true,
    });
  } else {
    await github.updatePullRequestBody(pr.number, body);
  }

  const note =
    ci === undefined
      ? "its local pre-check is still failing"
      : ci.reason === "timeout"
        ? "its required checks did not complete in time"
        : "its required checks are still red";
  await github.createIssueComment(
    issue.number,
    `🦉 fixowl opened ${pr.url} for this issue as a draft after ${ctx.ciMaxTries} attempt(s); ${note}. See the PR for the outstanding failures.`,
  );

  return {
    ...base,
    status: "pr-opened",
    prNumber: pr.number,
    prUrl: pr.url,
    draft: true,
    verification: state.lastVerification,
  };
}

/** The failed local pre-check outcomes, as feedback for the next agent pass. */
function localFeedback(verification: readonly CheckOutcome[]): CheckFailureFeedback[] {
  return verification
    .filter((outcome) => outcome.status === "failed")
    .map((outcome) => ({
      source: "local" as const,
      name: outcome.name,
      detail: outcome.log ?? outcome.detail ?? "(no output captured)",
    }));
}

/** The red/timed-out CI result, as feedback for the next agent pass. */
async function ciFeedback(
  github: GitHubApi,
  ci: WaitForChecksResult,
): Promise<CheckFailureFeedback[]> {
  const feedback: CheckFailureFeedback[] = [];
  if (ci.timedOut) {
    feedback.push({
      source: "ci",
      name: "(CI timeout)",
      detail:
        "The required checks did not all complete within fixowl's time budget. " +
        "Make the change build and run as fast as it can, and fix any check that did complete red below.",
    });
  }
  for (const check of ci.failed) {
    const logs = await github.getFailedCheckLogs(check);
    const detail =
      logs ??
      check.summary ??
      `(no output available; conclusion: ${check.conclusion ?? "unknown"})`;
    feedback.push({ source: "ci", name: check.name, detail });
  }
  if (feedback.length === 0) {
    feedback.push({
      source: "ci",
      name: "(CI)",
      detail: "The required checks did not pass, but no failure detail was available.",
    });
  }
  return feedback;
}

function toCiCheckFailure(check: CheckStatusLite): CiCheckFailure {
  return { name: check.name, summary: check.summary, detailsUrl: check.detailsUrl };
}

/** Reads the base branch's required checks, never throwing: any error falls back to gating on all checks. */
async function readRequiredChecks(
  github: GitHubApi,
  base: string,
  log: Logger,
): Promise<RequiredChecks> {
  try {
    return await github.getRequiredChecks(base);
  } catch (error) {
    log.warn(`could not read required checks for ${base}: ${String(error)}; gating on all checks`);
    return { readable: false, contexts: [] };
  }
}
