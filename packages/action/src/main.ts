import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentAdapter,
  issueBranchName,
  PROMPT_MOUNT_PATH,
  REPO_CONFIG_PATH,
  repoFileConfigSchema,
  type LabelRule,
  type RepoFileConfig,
} from "@fixowl/core";
import { parse as parseYaml } from "yaml";
import { allIndependent, buildClassifyPrompt, parseClassification } from "./classify.ts";
import { planChains } from "./chain-planner.ts";
import { containerName } from "./container-exec.ts";
import type {
  ContainerEngine,
  ContainerMount,
  Exec,
  GitHubApi,
  IssueLite,
  Logger,
} from "./deps.ts";
import { GitWorkspace } from "./git-ops.ts";
import { filterAlreadyAttempted } from "./idempotency.ts";
import { selectIssues } from "./issue-selection.ts";
import { processIssue, type IssueResult } from "./issue-pipeline.ts";

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
  workspaceDir: string;
  tempDir: string;
  runUrl?: string;
  /** Runtime PAT used for pushes; omitted in tests that push to a local remote. */
  pushToken?: string;
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
  warnings: string[];
}

export async function runNight(deps: NightDeps, inputs: NightInputs): Promise<NightSummary> {
  const { github, engine, exec, log } = deps;
  const warnings: string[] = [];
  const git = new GitWorkspace(exec, inputs.workspaceDir);

  await git.configureIdentity();
  if (inputs.pushToken !== undefined) {
    await git.setRemoteWithToken(inputs.repoFullName, inputs.pushToken);
  }

  const repoConfig = loadRepoConfig(inputs.workspaceDir, warnings);
  const adapter = getAgentAdapter(
    inputs.agentName,
    inputs.agentEnvNames !== undefined && inputs.agentEnvNames.length > 0
      ? inputs.agentEnvNames
      : undefined,
  );
  const agentEnv = resolveAgentEnv(adapter.env, inputs.env);

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
    return { results: [], skipped, warnings };
  }

  const image = await buildTargetImage(engine, git, inputs.workspaceDir, repoConfig);

  const chainNumbers = await classifyIssues({
    engine,
    log,
    warnings,
    selected,
    adapter,
    agentEnv,
    image,
    inputs,
  });
  const chains = planChains(selected, chainNumbers);

  const results: IssueResult[] = [];
  for (const chain of chains) {
    let baseRef = `origin/${inputs.defaultBranch}`;
    let prBase = inputs.defaultBranch;
    let stackedOn: { prNumber: number; branch: string } | undefined;
    for (const issue of chain) {
      const branch = issueBranchName(issue.number, issue.title);
      let result: IssueResult;
      try {
        result = await processIssue(
          { git, engine, github, log },
          {
            issue,
            branch,
            baseRef,
            prBase,
            stackedOn,
            image,
            repoConfig,
            adapter,
            agentEnv,
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
      }
    }
  }

  return { results, skipped, warnings };
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
}): Promise<number[][]> {
  const { engine, log, warnings, selected, adapter, agentEnv, image, inputs } = params;
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
    name: containerName("classify", adapter.name),
    workspaceDir: inputs.workspaceDir,
    workspaceReadOnly: true,
    argv: adapter.argv("classify"),
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

function tail(text: string, max: number): string {
  return text.length <= max ? text : `...${text.slice(-max)}`;
}

export function renderSummary(repoFullName: string, summary: NightSummary): string {
  const lines: string[] = [`# 🦉 fixowl night run: ${repoFullName}`, ""];
  if (summary.results.length === 0 && summary.skipped.length === 0) {
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
        result.error !== undefined ? `${result.status} (${result.error})` : result.status;
      lines.push(
        `| #${result.issue.number} ${result.issue.title} | ${status} | ${pr} | ${verification} |`,
      );
    }
    lines.push("");
  }
  if (summary.skipped.length > 0) {
    lines.push(`## Skipped (branch already exists)`, "");
    for (const skip of summary.skipped) {
      lines.push(`- #${skip.issue.number} ${skip.issue.title}: \`${skip.branch}\``);
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
