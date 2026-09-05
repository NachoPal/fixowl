import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentAdapter,
  guardScheduledSlot,
  issueBranchName,
  PROMPT_MOUNT_PATH,
  REPO_CONFIG_PATH,
  repoFileConfigSchema,
  resolveModelSelection,
  type LabelModelMap,
  type LabelRule,
  type ModelSelection,
  type RepoFileConfig,
} from "@fixowl/core";
import { parse as parseYaml } from "yaml";
import { allIndependent, buildClassifyPrompt, parseClassification } from "./classify.ts";
import { planChains } from "./chain-planner.ts";
import { containerName } from "./container-exec.ts";
import { mergeGraphs } from "./merge-graph.ts";
import { planPrereqs, type DeferredIssue, type InFlightPrereq } from "./prereq-planner.ts";
import type {
  ContainerEngine,
  ContainerMount,
  Exec,
  GitHubApi,
  IssueDeps,
  IssueLite,
  Logger,
} from "./deps.ts";
import { extractGitDir, GitWorkspace, restoreGitDir } from "./git-ops.ts";
import { filterAlreadyAttempted } from "./idempotency.ts";
import { selectIssues } from "./issue-selection.ts";
import { markdownCell, processIssue, tail, type IssueResult } from "./issue-pipeline.ts";

const CLASSIFY_TIMEOUT_MS = 10 * 60 * 1000;

export interface NightInputs {
  repoFullName: string;
  defaultBranch: string;
  labels: LabelRule;
  agentName: string;
  /** Overrides the adapter's built-in env allowlist when non-empty. */
  agentEnvNames?: string[];
  maxIssues: number;
  issueTimeoutMinutes: number;
  /** Default model when an issue carries no selector label; undefined uses the CLI default. */
  defaultModel?: string;
  /** Default reasoning effort when an issue carries no selector label. */
  defaultEffort?: string;
  /** Selector-label -> {model, effort}; per-issue resolution reads this. */
  labelModels?: LabelModelMap;
  /**
   * Opt-in Layer 2: when true, run the heuristic same-files classifier and stack
   * its conflict groups. Default (undefined/false) skips the classifier entirely
   * and treats every non-deferred issue as independent. Layer 1 native
   * `blocked_by` ordering is always-on regardless.
   */
  heuristicConflictOrdering?: boolean;
  workspaceDir: string;
  tempDir: string;
  runUrl?: string;
  /**
   * Runtime PAT for authenticated fetch/push, injected per git command as an
   * env-based http.extraheader (never argv, never the workspace). Omitted in
   * tests that push to a local remote.
   */
  pushToken?: string;
  /**
   * Whether this run is a scheduled-slot run (the cron, or a fallback-tagged
   * dispatch) - as opposed to a plain manual dispatch. Only scheduled-slot runs
   * are subject to the once-a-day budget guard; manual runs are never limited.
   */
  scheduledSlot?: boolean;
  /** This run's id (GITHUB_RUN_ID), used by the scheduled-slot guard. */
  currentRunId?: number;
  /**
   * The workflow's cron expression (UTC), passed through by the generated
   * workflow. The scheduled-slot guard anchors its once-a-day window to this
   * occurrence; absent (an old workflow), it falls back to the UTC calendar day.
   */
  cronSchedule?: string;
  /** Source of agent env values (normally process.env). */
  env: Record<string, string | undefined>;
}

export interface NightDeps {
  github: GitHubApi;
  engine: ContainerEngine;
  exec: Exec;
  log: Logger;
}

export interface NightSummary {
  results: IssueResult[];
  skipped: Array<{ issue: IssueLite; branch: string }>;
  /** Issues held back tonight because a native prerequisite has not shipped (Layer 1). */
  deferred: DeferredIssue[];
  warnings: string[];
}

export async function runNight(deps: NightDeps, inputs: NightInputs): Promise<NightSummary> {
  // Budget guard: the scheduled nightly slot (cron or fallback-tagged dispatch)
  // must execute at most once a day. A late cron arriving after the fallback
  // already ran (or vice-versa) would otherwise spend usage on a second run;
  // this stands the later scheduled-slot run down before any git or container
  // work. A plain manual dispatch is never a scheduled-slot run, so it is never
  // limited. Runs before extractGitDir so a no-op costs nothing.
  const standDown = await checkScheduledSlotBudget(deps, inputs);
  if (standDown !== undefined) return standDown;

  // Structural backstop: move the git dir out of the workspace for the whole
  // night, so no container mount ever includes it and a `.git` a hostile
  // agent plants in the workspace is inert on the host (see git-ops.ts).
  const gitDir = extractGitDir(inputs.workspaceDir);
  const git = new GitWorkspace(deps.exec, inputs.workspaceDir, gitDir, inputs.pushToken);
  try {
    return await runNightWithGit(deps, inputs, git);
  } finally {
    try {
      restoreGitDir(inputs.workspaceDir, gitDir);
    } catch (error) {
      deps.log.warn(
        `failed to restore .git into the workspace: ${String(error)}; the next checkout re-clones`,
      );
    }
  }
}

/**
 * Enforces "the scheduled slot runs at most once a day". Returns an early no-op
 * summary when this run should stand down, or undefined to proceed. Only
 * scheduled-slot runs (cron or fallback-tagged dispatch) are considered; a plain
 * manual dispatch always proceeds. Listing runs needs Actions: read, provided by
 * the ephemeral `GITHUB_TOKEN` and not the runtime PAT; when that token (or the
 * run id) is unavailable - e.g. a workflow provisioned before this feature - the
 * guard fails open with a warning rather than skipping the night.
 */
async function checkScheduledSlotBudget(
  deps: NightDeps,
  inputs: NightInputs,
): Promise<NightSummary | undefined> {
  if (inputs.scheduledSlot !== true) return undefined;
  if (inputs.currentRunId === undefined) {
    deps.log.warn(
      "scheduled-slot budget guard disabled: this run's id is unavailable; " +
        "re-run `fixowl provision` to update the workflow",
    );
    return undefined;
  }
  const runs = await deps.github.listRecentWorkflowRuns();
  const guard = guardScheduledSlot({
    runs,
    now: new Date(),
    currentRunId: inputs.currentRunId,
    selfIsScheduledSlot: true,
    cronSchedule: inputs.cronSchedule,
  });
  if (guard.proceed) return undefined;
  deps.log.info(`🦉 fixowl: ${guard.reason}`);
  return { results: [], skipped: [], deferred: [], warnings: [guard.reason] };
}

async function runNightWithGit(
  deps: NightDeps,
  inputs: NightInputs,
  git: GitWorkspace,
): Promise<NightSummary> {
  const { github, engine, log } = deps;
  const warnings: string[] = [];

  await git.configureIdentity();

  const repoConfig = loadRepoConfig(inputs.workspaceDir, warnings);
  const adapter = getAgentAdapter(
    inputs.agentName,
    inputs.agentEnvNames !== undefined && inputs.agentEnvNames.length > 0
      ? inputs.agentEnvNames
      : undefined,
  );
  const agentEnv = resolveAgentEnv(adapter.env, inputs.env, warnings);

  const matching = await selectIssues(github, inputs.labels);
  log.info(`${matching.length} open issue(s) match the label rule`);
  const { selected: fresh, skipped } = filterAlreadyAttempted(
    matching,
    await git.listRemoteIssueBranches(),
  );
  for (const skip of skipped) {
    log.info(`issue #${skip.issue.number}: skipping, branch ${skip.branch} already exists`);
  }
  const selected = fresh.slice(0, inputs.maxIssues);
  if (fresh.length > selected.length) {
    log.info(
      `capping to ${inputs.maxIssues} issue(s); ${fresh.length - selected.length} left for the next night`,
    );
  }
  if (selected.length === 0) {
    log.info("nothing to do tonight");
    return { results: [], skipped, deferred: [], warnings };
  }

  // Layer 1 (authoritative): fetch native prerequisite edges and enforce them.
  // A dependent whose prerequisite is not in tonight's shippable set is deferred;
  // the rest are ordered so a prerequisite always precedes (and is stacked under)
  // its dependent. With no edges this is a no-op and the night is unchanged.
  const depsMap = await github.getIssueDependencies(selected.map((issue) => issue.number));

  // A native blocked_by edge may point at an issue idempotency skipped because
  // its branch is already in flight. Rather than defer the dependent every night
  // (Layer 1's default), stack it on that prerequisite's existing branch - but
  // only while the prerequisite is genuinely in flight. This resolves each such
  // prerequisite's PR liveness (read-only) so the pure planner can gate on it.
  const inFlight = await resolveInFlightPrereqs(github, depsMap, skipped, inputs.repoFullName);

  const prereqPlan = planPrereqs(selected, depsMap, inputs.repoFullName, inFlight);
  for (const warning of prereqPlan.warnings) {
    warnings.push(warning);
    log.warn(warning);
  }
  const deferred: DeferredIssue[] = [...prereqPlan.deferred];
  for (const item of deferred) {
    log.info(`issue #${item.issue.number}: deferred - ${item.reason}`);
  }
  const shippable = prereqPlan.shippable;
  if (shippable.length === 0) {
    log.info("nothing shippable tonight; every selected issue is deferred");
    return { results: [], skipped, deferred, warnings };
  }

  const image = await buildTargetImage(engine, git, inputs.workspaceDir, repoConfig);

  const labelModels: LabelModelMap = inputs.labelModels ?? {};
  const defaultSelection: ModelSelection = {
    model: inputs.defaultModel,
    effort: inputs.defaultEffort,
  };

  // Layer 2 (heuristic, opt-in): the LLM same-files classifier runs only over
  // the non-deferred set; its conflict groups are then merged onto the Layer-1
  // prerequisite order under "prerequisites always win". Off by default - fixowl
  // never merges, so it never restacks what it stacks; independent PRs review
  // more robustly, and the classifier is a paid LLM guess (see docs/stacked-prs.md).
  // When off, the classifier call is skipped entirely and every non-deferred
  // issue is independent; Layer 1 native `blocked_by` ordering still applies via
  // mergeGraphs below in both modes.
  const conflictChains =
    inputs.heuristicConflictOrdering === true
      ? await classifyIssues({
          engine,
          log,
          warnings,
          selected: shippable,
          adapter,
          agentEnv,
          image,
          inputs,
          // Classification spans all issues at once, so it uses the repo default,
          // not any single issue's selector label.
          selection: defaultSelection,
        })
      : allIndependent(shippable.map((issue) => issue.number));
  const chainNumbers = mergeGraphs(conflictChains, prereqPlan.prereqs);
  const chains = planChains(shippable, chainNumbers);

  // A prerequisite that fails to ship at runtime defers its dependents (contrast
  // a conflict chain, whose downstream simply rebases onto the default branch).
  const shipped = new Set<number>();

  const results: IssueResult[] = [];
  for (const chain of chains) {
    let baseRef = `origin/${inputs.defaultBranch}`;
    let prBase = inputs.defaultBranch;
    let stackedOn: { prNumber: number; branch: string } | undefined;
    for (const issue of chain) {
      const unshipped = (prereqPlan.prereqs.get(issue.number) ?? []).filter(
        (prereq) => !shipped.has(prereq),
      );
      if (unshipped.length > 0) {
        const reason = `prerequisite ${unshipped.map((n) => `#${n}`).join(", ")} did not ship tonight`;
        log.info(`issue #${issue.number}: deferred - ${reason}`);
        deferred.push({ issue, reason });
        continue;
      }
      const branch = issueBranchName(issue.number, issue.title);

      // A native in-flight prerequisite (issue #48) roots this issue on the
      // prerequisite's already-pushed branch instead of the chain's running base
      // or the default branch - authoritative over any heuristic chain position.
      // The base branch is fetched first so `origin/<branch>` resolves; a fetch
      // failure defers just this issue rather than crashing the night.
      const stackBase = prereqPlan.stackBases.get(issue.number);
      let issueBaseRef = baseRef;
      let issuePrBase = prBase;
      let issueStackedOn = stackedOn;
      if (stackBase !== undefined) {
        try {
          await git.fetchRemoteBranch(stackBase.branch);
        } catch (error) {
          const reason = `could not fetch in-flight prerequisite branch ${stackBase.branch}: ${String(error)}`;
          log.info(`issue #${issue.number}: deferred - ${reason}`);
          deferred.push({ issue, reason });
          continue;
        }
        issueBaseRef = `origin/${stackBase.branch}`;
        issuePrBase = stackBase.branch;
        issueStackedOn = { prNumber: stackBase.prNumber, branch: stackBase.branch };
        log.info(
          `issue #${issue.number}: stacking on in-flight prerequisite PR #${stackBase.prNumber} (${stackBase.branch})`,
        );
      }

      // Resolve this issue's model/effort from its labels. A multi-selector-
      // label conflict fails just this issue, loudly, without touching the rest.
      const resolution = resolveModelSelection({
        issueLabels: issue.labels,
        labelModels,
        default: defaultSelection,
      });
      if (!resolution.ok) {
        log.error(`issue #${issue.number}: ${resolution.error}`);
        results.push({ issue, branch, status: "error", verification: [], error: resolution.error });
        continue;
      }
      if (resolution.source === "label") {
        log.info(
          `issue #${issue.number}: selector label "${resolution.label}" -> model ${resolution.selection.model}, effort ${resolution.selection.effort}`,
        );
      }

      let result: IssueResult;
      try {
        result = await processIssue(
          { git, engine, github, log },
          {
            issue,
            branch,
            baseRef: issueBaseRef,
            prBase: issuePrBase,
            stackedOn: issueStackedOn,
            image,
            repoFullName: inputs.repoFullName,
            repoConfig,
            adapter,
            agentEnv,
            selection: resolution.selection,
            workspaceDir: inputs.workspaceDir,
            promptDir: join(inputs.tempDir, "fixowl-prompts"),
            evidenceDir: join(inputs.tempDir, "fixowl-evidence", `issue-${issue.number}`),
            timeoutMs: inputs.issueTimeoutMinutes * 60 * 1000,
            runUrl: inputs.runUrl,
          },
        );
      } catch (error) {
        log.error(`issue #${issue.number}: ${String(error)}`);
        try {
          await git.discardAllChanges();
        } catch {
          // best effort; the next checkout -B will complain if the tree is truly wedged
        }
        result = {
          issue,
          branch,
          status: "error",
          verification: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      results.push(result);
      if (result.status === "pr-opened" && result.prNumber !== undefined) {
        // The next chain member stacks on this branch; failed members are skipped over.
        baseRef = branch;
        prBase = branch;
        stackedOn = { prNumber: result.prNumber, branch };
        shipped.add(issue.number);
      }
    }
  }

  return { results, skipped, deferred, warnings };
}

/**
 * For each idempotency-skipped issue that is a native prerequisite of a selected
 * issue (an OPEN, same-repo `blocked_by` edge), read its PR state so Layer 1 can
 * decide whether its in-flight branch is a live stacking base (issue #48). Only
 * genuine prerequisites are looked up, so a night with no such edges makes no
 * extra GitHub calls. Native edges only - the heuristic classifier never stacks
 * on a skipped branch across nights.
 */
async function resolveInFlightPrereqs(
  github: GitHubApi,
  depsMap: Map<number, IssueDeps>,
  skipped: ReadonlyArray<{ issue: IssueLite; branch: string }>,
  currentRepo: string,
): Promise<Map<number, InFlightPrereq>> {
  const branchByNumber = new Map(skipped.map((skip) => [skip.issue.number, skip.branch]));
  const prereqNumbers = new Set<number>();
  for (const issueDeps of depsMap.values()) {
    for (const edge of issueDeps.blockedBy) {
      if (edge.state === "OPEN" && edge.repo === currentRepo && branchByNumber.has(edge.number)) {
        prereqNumbers.add(edge.number);
      }
    }
  }
  const inFlight = new Map<number, InFlightPrereq>();
  for (const number of prereqNumbers) {
    const branch = branchByNumber.get(number) as string;
    const pr = await github.getPullRequestForBranch(branch);
    inFlight.set(number, { branch, pr });
  }
  return inFlight;
}

function loadRepoConfig(workspaceDir: string, warnings: string[]): RepoFileConfig {
  const path = join(workspaceDir, REPO_CONFIG_PATH);
  if (!existsSync(path)) {
    warnings.push(`${REPO_CONFIG_PATH} not found; verification unavailable for this repo`);
    return { version: 1 };
  }
  return repoFileConfigSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

function resolveAgentEnv(
  names: readonly string[],
  env: Record<string, string | undefined>,
  warnings: string[],
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === "") missing.push(name);
    else resolved[name] = value;
  }
  if (names.length > 0 && missing.length === names.length) {
    throw new Error(
      `none of the agent's required env vars are set (${names.join(", ")}); ` +
        `check the repo's Actions secrets and the workflow env block`,
    );
  }
  for (const name of missing) {
    warnings.push(
      `agent env var ${name} is not set; the agent runs without it (check the repo's Actions secrets)`,
    );
  }
  return resolved;
}

async function buildTargetImage(
  engine: ContainerEngine,
  git: GitWorkspace,
  workspaceDir: string,
  repoConfig: RepoFileConfig,
): Promise<string> {
  const dockerfile = repoConfig.dockerfile ?? "Dockerfile";
  if (!existsSync(join(workspaceDir, dockerfile))) {
    throw new Error(
      `dockerfile "${dockerfile}" not found in the repo; fixowl needs a per-repo image to run agents in`,
    );
  }
  const image = `fixowl-target:${(await git.headSha()).slice(0, 12)}`;
  const result = await engine.build({ image, dockerfile, contextDir: workspaceDir });
  if (result.code !== 0) {
    throw new Error(`docker build failed (exit ${result.code}): ${tail(result.stderr, 2000)}`);
  }
  try {
    await engine.pruneImages?.("fixowl-target", image);
  } catch {
    // best effort; a failed prune must never fail the night
  }
  return image;
}

async function classifyIssues(params: {
  engine: ContainerEngine;
  log: Logger;
  warnings: string[];
  selected: IssueLite[];
  adapter: ReturnType<typeof getAgentAdapter>;
  agentEnv: Record<string, string>;
  image: string;
  inputs: NightInputs;
  selection: ModelSelection;
}): Promise<number[][]> {
  const { engine, log, warnings, selected, adapter, agentEnv, image, inputs, selection } = params;
  const numbers = selected.map((issue) => issue.number);
  if (selected.length < 2) return allIndependent(numbers);

  log.info(`classifying ${selected.length} issues into dependency chains`);
  const prompt = buildClassifyPrompt(selected);
  let stdin: string | undefined;
  const extraMounts: ContainerMount[] = [];
  if (adapter.promptVia === "stdin") {
    stdin = prompt;
  } else {
    const promptDir = join(inputs.tempDir, "fixowl-prompts");
    mkdirSync(promptDir, { recursive: true });
    const promptFile = join(promptDir, "classify.md");
    writeFileSync(promptFile, prompt);
    extraMounts.push({ host: promptFile, container: PROMPT_MOUNT_PATH, readOnly: true });
  }
  const result = await engine.run({
    image,
    name: containerName(inputs.repoFullName, "classify", adapter.name),
    workspaceDir: inputs.workspaceDir,
    workspaceReadOnly: true,
    argv: adapter.argv("classify", selection),
    env: agentEnv,
    extraMounts,
    stdin,
    timeoutMs: CLASSIFY_TIMEOUT_MS,
  });
  if (result.code !== 0 || result.timedOut) {
    warnings.push(
      `classification agent failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}); treating all issues as independent`,
    );
    return allIndependent(numbers);
  }
  const classification = parseClassification(result.stdout, numbers);
  if (classification.fallback && classification.warning !== undefined) {
    warnings.push(classification.warning);
  }
  if (!classification.fallback) {
    log.info(
      `chains: ${classification.chains.map((chain) => `[${chain.join(" -> ")}]`).join(" ")}`,
    );
  }
  return classification.chains;
}

/**
 * A night that had shippable work but shipped nothing because every attempted
 * issue failed is a total outage, not a quiet success - it must fail the job.
 * Returns a message when that happened, otherwise undefined.
 *
 * Only issues that were actually attempted appear in `results` (deferred and
 * already-skipped issues do not), and each carries an `IssueResult.status`. Red
 * requires that at least one issue was attempted and *every* one ended in a
 * hard failure ("agent-failed" or "error"). This keeps the benign outcomes
 * green: no matching issues (empty results), an agent that ran fine but had
 * "no-changes", and any partial night where at least one "pr-opened" landed.
 */
export function wipeoutFailure(summary: NightSummary): string | undefined {
  const attempted = summary.results;
  if (attempted.length === 0) return undefined;
  const allFailed = attempted.every(
    (result) => result.status === "agent-failed" || result.status === "error",
  );
  if (!allFailed) return undefined;
  const numbers = attempted.map((result) => `#${result.issue.number}`).join(", ");
  return (
    `every one of the ${attempted.length} shippable issue(s) failed and no PR was opened ` +
    `(${numbers}); see the run summary for per-issue errors`
  );
}

export function renderSummary(repoFullName: string, summary: NightSummary): string {
  const lines: string[] = [`# 🦉 fixowl night run: ${repoFullName}`, ""];
  if (
    summary.results.length === 0 &&
    summary.skipped.length === 0 &&
    summary.deferred.length === 0
  ) {
    lines.push("No open issues matched the label rule. Sleep tight.");
  }
  if (summary.results.length > 0) {
    lines.push(`| issue | status | PR | verification |`, `| --- | --- | --- | --- |`);
    for (const result of summary.results) {
      const pr =
        result.prUrl !== undefined
          ? `[#${result.prNumber}](${result.prUrl})${result.draft ? " (draft)" : ""}`
          : "-";
      const verification =
        result.verification.length > 0
          ? result.verification.map((check) => `${check.name}: ${check.status}`).join("<br>")
          : "-";
      const status =
        result.error !== undefined
          ? `${result.status} (${markdownCell(result.error)})`
          : result.status;
      lines.push(
        `| #${result.issue.number} ${markdownCell(result.issue.title)} | ${status} | ${pr} | ${verification} |`,
      );
    }
    lines.push("");
  }
  if (summary.skipped.length > 0) {
    lines.push(`## Skipped (branch already exists)`, "");
    for (const skip of summary.skipped) {
      lines.push(`- #${skip.issue.number} ${markdownCell(skip.issue.title)}: \`${skip.branch}\``);
    }
    lines.push("");
  }
  if (summary.deferred.length > 0) {
    lines.push(`## Deferred (blocked by an unshipped prerequisite)`, "");
    for (const item of summary.deferred) {
      lines.push(
        `- #${item.issue.number} ${markdownCell(item.issue.title)}: ${markdownCell(item.reason)}`,
      );
    }
    lines.push("");
  }
  if (summary.warnings.length > 0) {
    lines.push(`## Warnings`, "");
    for (const warning of summary.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
