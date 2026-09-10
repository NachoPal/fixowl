import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addSamples,
  getSpendMeter,
  PROMPT_MOUNT_PATH,
  type AgentAdapter,
  type CheckStatusLite,
  type ModelSelection,
  type RepoFileConfig,
  type RequiredChecks,
  type SpendSample,
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
import { TRIAGED_LABEL, triageComment, type TriageCategory, type TriagedIssue } from "./triage.ts";
import { parseVerdict, type Verdict } from "./verdict.ts";
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
  /**
   * Layer B: when true, the fix prompt asks the agent to verify against the
   * current code first, and a no-diff run leaves a comment + `fixowl:triaged`
   * label and opens NO PR (instead of a silent no-changes). Default resolves on
   * from config (see docs/issue-triage.md).
   */
  verifyBeforeFix: boolean;
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
  /**
   * Total tokens this issue's agent passes spent, summed across the CI-gated
   * loop's attempts; undefined when the agent's spend is unmeasurable (a
   * subscription agent, or an unparseable output). The run loop accumulates this
   * across issues for the `total_token_budget` stop condition.
   */
  usage?: SpendSample;
  /**
   * Set on a Layer B skip: the agent produced no diff, so no PR was opened and
   * fixowl left a comment + `fixowl:triaged` label. main.ts folds this into the
   * run summary's Triaged-out section. Status stays "no-changes" (benign).
   */
  triaged?: TriagedIssue;
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
  // Accumulated token spend across this issue's agent passes; folded after each
  // pass and mirrored onto `base` so every return path carries it (finishExhausted
  // receives it explicitly). undefined stays undefined - abstain - until a pass
  // reports measurable usage.
  let usage: SpendSample | undefined;

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
  // Layer B: the first pass's verify-first verdict (advisory), read from stdout.
  let firstPassVerdict: Verdict | undefined;

  try {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const agentResult = await runAgent(deps, ctx, { attempt, previousFailures });
      if (agentResult.usage !== undefined) {
        usage = usage === undefined ? agentResult.usage : addSamples(usage, agentResult.usage);
        base.usage = usage;
      }

      if (attempt === 1 && ctx.verifyBeforeFix) {
        firstPassVerdict = parseVerdict(agentResult.stdout);
      }

      if (agentResult.timedOut || agentResult.code !== 0) {
        // A provider limit or hard crash surfaces here. The uncommitted work is
        // discarded, but if a draft PR was already opened on an earlier pass we must
        // NOT drop it from the result: that strands an unexplained draft that then
        // blocks the issue from ever being picked up again (issue #72). Route it
        // through the annotate-and-leave-a-draft path instead of the bare stop.
        await git.discardAllChanges();
        const reason = agentResult.timedOut
          ? `agent timed out after ${ctx.timeoutMs}ms`
          : `agent exited with code ${agentResult.code}`;
        const output = `${agentResult.stdout}\n${agentResult.stderr}`.trim();
        const excerpt =
          output.length > 0 ? markdownCell(tail(output, AGENT_ERROR_EXCERPT_MAX)) : "";
        const errorMessage = excerpt.length > 0 ? `${reason} - ${excerpt}` : reason;
        if (pr !== undefined) {
          return await finishFailedAfterPr(deps, ctx, {
            pr,
            lastVerification,
            lastCi,
            usage,
            error: errorMessage,
          });
        }
        return { ...base, status: "agent-failed", error: errorMessage };
      }

      if (attempt === 1 && !(await git.hasChangesAgainst(ctx.baseRef))) {
        // No diff: never open a PR. Layer B turns this into a triage skip (comment
        // + `fixowl:triaged` label + summary line); with verify-first off it is the
        // pre-existing silent no-changes.
        return await handleNoDiff(deps, ctx, base, firstPassVerdict);
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

      // The attempt-1 no-diff guard above only catches the first pass. A later pass
      // can also land the tree back at base (the agent undoing its own earlier
      // change); with no PR open yet, committing/pushing here would create an empty
      // branch and ensurePullRequest would 422 "No commits between ..." (issue #75).
      // Re-check before every push while no PR exists: attempt 1 goes through Layer-B
      // triage, a later pass is a plain no-changes.
      if (pr === undefined && !(await git.hasChangesAgainst(ctx.baseRef))) {
        return attempt === 1
          ? await handleNoDiff(deps, ctx, base, firstPassVerdict)
          : { ...base, status: "no-changes" };
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

      // Green and unverified both flip the PR to ready (settle-then-ready, captain
      // 7.2), but they must NEVER read the same to a human: unverified means zero
      // checks were consulted, so its wording says CI could not be verified, never
      // "green". Red/timeout falls through to the retry / exhaustion path below.
      if (ci.outcome === "green" || ci.outcome === "unverified") {
        await github.markPullRequestReadyForReview(pr.number);
        const summary: CiGateSummary =
          ci.outcome === "unverified"
            ? { state: "unverified" }
            : { state: "green", usedFallback: ci.usedFallback };
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
        const comment =
          ci.outcome === "unverified"
            ? `🦉 fixowl opened ${pr.url} for this issue and flipped it to ready, but CI could ` +
              `not be verified: the runtime credential cannot read this branch's check runs, so no ` +
              `checks were consulted. Review CI on the PR before merging.`
            : `🦉 fixowl opened ${pr.url} for this issue; its required checks are green and it is ready for review.`;
        log.info(
          ci.outcome === "unverified"
            ? `issue #${issue.number}: CI unverified (checks unreadable); PR #${pr.number} flipped to ready`
            : `issue #${issue.number}: required checks green; PR #${pr.number} ready for review`,
        );
        await github.createIssueComment(issue.number, comment);
        return {
          ...base,
          status: "pr-opened",
          prNumber: pr.number,
          prUrl: pr.url,
          draft: false,
          verification,
        };
      }

      // Only a concrete red check gives the agent something to fix. A required
      // context that never registered (`stalled`) will never run for this change,
      // and a bare timeout with nothing red gives the agent no failure to act on;
      // retrying either just burns another paid pass and the full timeout again
      // (issue #74). Stop and leave the draft annotated with what happened.
      if (ci.outcome === "stalled" || ci.failed.length === 0) {
        log.info(
          `issue #${issue.number}: ${
            ci.outcome === "stalled"
              ? "a required check never started for this change"
              : "CI did not complete and nothing is red"
          }; leaving an annotated draft without re-running the agent (attempt ${attempt}/${maxTries})`,
        );
        break;
      }

      previousFailures = await ciFeedback(github, ci);
      log.info(
        `issue #${issue.number}: CI ${ci.timedOut ? "did not complete in time" : "is red"} ` +
          `(attempt ${attempt}/${maxTries})`,
      );
    }

    return finishExhausted(deps, ctx, {
      title,
      pr,
      lastVerification,
      lastCi,
      usage,
      firstPassVerdict,
    });
  } catch (error) {
    // Something threw after we may have already opened the draft PR (a hard CI
    // read failure that survived the poll loop's transient-error absorption, a
    // push/annotate error). If a draft exists, annotate and keep it rather than
    // let main.ts build a PR-less `error` result that strands the draft forever
    // (issue #72); with no PR yet, rethrow so the caller resets the tree as before.
    if (pr !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      return await finishFailedAfterPr(deps, ctx, {
        pr,
        lastVerification,
        lastCi,
        usage,
        error: `error after the draft PR was opened - ${markdownCell(message)}`,
      });
    }
    throw error;
  }
}

/**
 * The agent produced no diff, so no PR is opened. With verify-first on (Layer B)
 * fixowl leaves an explanatory comment and stamps the `fixowl:triaged` label so
 * the issue drops out of the next night, and reports it via `IssueResult.triaged`;
 * the comment/label are best-effort so a write failure never aborts the night.
 * With verify-first off this is the pre-existing silent no-changes.
 */
async function handleNoDiff(
  deps: IssuePipelineDeps,
  ctx: IssueRunContext,
  base: Omit<IssueResult, "status">,
  verdict: Verdict | undefined,
): Promise<IssueResult> {
  const { github, log } = deps;
  const { issue } = ctx;
  log.warn(`issue #${issue.number}: agent finished but produced no changes`);
  if (!ctx.verifyBeforeFix) {
    return { ...base, status: "no-changes" };
  }
  const category = noDiffCategory(verdict);
  const explanation =
    verdict?.explanation !== undefined ? markdownCell(verdict.explanation) : undefined;
  const triaged: TriagedIssue = { issue, layer: "agent", category, explanation };
  try {
    await github.createIssueComment(issue.number, triageComment(triaged));
    await github.addLabels(issue.number, [TRIAGED_LABEL]);
  } catch (error) {
    log.warn(
      `issue #${issue.number}: could not leave the no-change triage comment/label (${String(error)}); ` +
        `it is still reported in the run summary`,
    );
  }
  log.info(`issue #${issue.number}: triaged (${category}); no PR opened`);
  return { ...base, status: "no-changes", triaged };
}

/** Map a Layer B verdict to the no-diff triage category (default: a plain no-change). */
function noDiffCategory(verdict: Verdict | undefined): TriageCategory {
  if (verdict?.verdict === "already-implemented" || verdict?.verdict === "partial") {
    // A `partial` verdict with no diff means the agent judged the remainder
    // already present too; treat it as already-implemented for the comment.
    return "already-implemented";
  }
  if (verdict?.verdict === "not-applicable") return "not-applicable";
  return "no-change";
}

/** Runs the agent container once, writing its output to the per-attempt evidence log. */
async function runAgent(
  deps: IssuePipelineDeps,
  ctx: IssueRunContext,
  params: { attempt: number; previousFailures: readonly CheckFailureFeedback[] | undefined },
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  usage: SpendSample | undefined;
}> {
  const { engine, log } = deps;
  const { issue } = ctx;

  const prompt = buildFixPrompt({
    issue,
    repoConfig: ctx.repoConfig,
    previousFailures: params.previousFailures,
    verifyFirst: ctx.verifyBeforeFix,
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
  // Measure this pass's token spend in-band from the agent's own captured output
  // (undefined for a subscription agent or an unparseable output; see agent-spend.ts).
  const usage = getSpendMeter(ctx.adapter.name).parse(result.stdout, result.stderr);
  return { ...result, usage };
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
    usage: SpendSample | undefined;
    firstPassVerdict: Verdict | undefined;
  },
): Promise<IssueResult> {
  const { git, github, log } = deps;
  const { issue } = ctx;
  const base: Omit<IssueResult, "status"> = {
    issue,
    branch: ctx.branch,
    verification: [],
    usage: state.usage,
  };
  log.warn(`issue #${issue.number}: exhausted ${ctx.ciMaxTries} attempt(s); leaving a draft PR`);

  let pr = state.pr;
  if (pr === undefined) {
    if (!(await git.hasChangesAgainst(ctx.baseRef))) {
      return await handleNoDiff(
        deps,
        ctx,
        { ...base, verification: state.lastVerification },
        state.firstPassVerdict,
      );
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
    state.lastCi !== undefined ? ciSummaryFromWait(state.lastCi) : undefined;

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
        : ci.reason === "stalled"
          ? "a required check never started for this change"
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

/**
 * The PR-body CI section for a non-green wait result: a stalled required check,
 * a bare timeout, or a red set. Shared by `finishExhausted` and
 * `finishFailedAfterPr` so a draft is annotated the same way however it ended.
 */
function ciSummaryFromWait(ci: WaitForChecksResult): Extract<CiGateSummary, { state: "failed" }> {
  const reason = ci.outcome === "stalled" ? "stalled" : ci.timedOut ? "timeout" : "red";
  return {
    state: "failed",
    reason,
    failures: ci.failed.map(toCiCheckFailure),
    usedFallback: ci.usedFallback,
  };
}

/**
 * A failure happened AFTER the draft PR was already opened - the agent crashed or
 * timed out on a later pass, or something threw inside the loop. Dropping the PR
 * from the result would leave an unexplained draft that blocks the issue from
 * ever being picked up again (issue #72). Instead annotate the existing draft
 * with the last CI failures and the error, post an explanatory comment, and
 * return a result that carries the PR number/URL and `draft: true` so the run
 * summary is coherent. The annotation is best-effort: a write failure here must
 * not lose the PR info the returned result now carries.
 */
async function finishFailedAfterPr(
  deps: IssuePipelineDeps,
  ctx: IssueRunContext,
  state: {
    pr: { number: number; url: string };
    lastVerification: CheckOutcome[];
    lastCi: WaitForChecksResult | undefined;
    usage: SpendSample | undefined;
    error: string;
  },
): Promise<IssueResult> {
  const { git, github, log } = deps;
  const { issue } = ctx;
  log.warn(
    `issue #${issue.number}: failed after draft PR #${state.pr.number} was opened (${state.error}); ` +
      `leaving it annotated so it is not silently stranded`,
  );
  try {
    // Any uncommitted last-attempt work never passed the local pre-check and was
    // never committed; discard it so the branch stays at the last pushed commit.
    await git.discardAllChanges();
  } catch (discardError) {
    log.warn(
      `issue #${issue.number}: could not discard changes after the failure (${String(discardError)})`,
    );
  }
  const ci: CiGateSummary | undefined =
    state.lastCi !== undefined ? ciSummaryFromWait(state.lastCi) : undefined;
  try {
    await github.updatePullRequestBody(
      state.pr.number,
      buildPrBody({
        issueNumber: issue.number,
        verification: state.lastVerification,
        stackedOn: ctx.stackedOn,
        runUrl: ctx.runUrl,
        ci,
      }),
    );
    await github.createIssueComment(
      issue.number,
      `🦉 fixowl left ${state.pr.url} as a draft: its fix loop stopped after an error (${state.error}). ` +
        `See the PR for the last checks; re-run fixowl or take it over.`,
    );
  } catch (writeError) {
    log.warn(
      `issue #${issue.number}: could not annotate the stranded draft PR (${String(writeError)}); ` +
        `the failure is still recorded with its PR in the run summary`,
    );
  }
  return {
    issue,
    branch: ctx.branch,
    status: "agent-failed",
    prNumber: state.pr.number,
    prUrl: state.pr.url,
    draft: true,
    verification: state.lastVerification,
    usage: state.usage,
    error: state.error,
  };
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
