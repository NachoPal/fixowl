import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Octokit } from "@octokit/rest";
import {
  APP_ID_SECRET,
  APP_INSTALLATION_ID_SECRET,
  APP_PRIVATE_KEY_SECRET,
  getAgentAdapter,
  labelsInRule,
  priorityLabelsToEnsure,
  renderFixowlWorkflow,
  resolveRepoSettings,
  REPO_CONFIG_PATH,
  STARTER_ISSUE_TEMPLATE,
  STARTER_ISSUE_TEMPLATE_PATH,
  STARTER_REPO_CONFIG,
  WORKFLOW_PATH,
} from "@fixowl/core";
import { ACTION_REPO, targetRepos, type CliContext } from "../context.ts";
import { publicClient } from "../github/client.ts";
import {
  FIXOWL_LABEL_COLOR,
  resolveActionRef,
  splitRepoFullName,
} from "../github/repo-provisioning.ts";
import { log } from "../log.ts";

export interface ManualProvisionOptions {
  noSchedule?: boolean;
  /** Where to write the emitted artifacts; defaults to ./fixowl-manual/<owner>-<repo>. */
  outDir?: string;
  /** Override for tests; defaults to an unauthenticated call against the public fixowl repo. */
  resolveActionRef?: (
    octokit: Octokit,
    actionRepo: string,
  ) => Promise<{ ref: string; comment: string }>;
}

/**
 * The no-admin-token provisioning path: emits the exact files and steps a
 * maintainer needs to provision a repo by hand, reusing the same renderers as
 * `fixowl provision` so the two never drift. Unlike `provisionCommand`, this
 * makes zero calls against the target repo - it never touches `ctx.admin` -
 * so it needs no admin PAT at all. The one network call it does make (resolving
 * the fixowl action's HEAD sha for SHA-pinning) hits the public fixowl repo
 * unauthenticated.
 */
export async function manualProvisionCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  options: ManualProvisionOptions = {},
): Promise<void> {
  const resolveRef = options.resolveActionRef ?? resolveActionRef;
  const actionRef = await resolveRef(publicClient(), ACTION_REPO);

  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    log.info(`\nmanual provisioning steps for ${repoFullName} (no admin token required)`);
    const ref = splitRepoFullName(repoFullName);
    const settings = resolveRepoSettings(ctx.config, repoFullName);
    const adapter = getAgentAdapter(settings.agent, settings.agentEnv);
    if (adapter.name === "script") {
      throw new Error(
        `repo ${repoFullName} is configured with the test-only "script" agent, which executes ` +
          `issue bodies as shell; refusing to provision it`,
      );
    }

    const cloudRunner = settings.runnerMode === "github-hosted";
    const workflow = renderFixowlWorkflow({
      runsOn: cloudRunner ? "ubuntu-latest" : undefined,
      schedule: options.noSchedule ? null : settings.schedule,
      labels: settings.labels,
      agent: adapter.name,
      agentEnv: adapter.env,
      maxIssuesPerRun: settings.maxIssuesPerRun,
      usageBudgetPercent: settings.usageBudgetPercent,
      totalTokenBudget: settings.totalTokenBudget,
      runBudgetMinutes: settings.runBudgetMinutes,
      issueTimeoutMinutes: settings.issueTimeoutMinutes,
      ciMaxTries: settings.ciMaxTries,
      ciTimeoutMinutes: settings.ciTimeoutMinutes,
      defaultModel: settings.defaultModel,
      defaultEffort: settings.defaultEffort,
      labelModels: settings.labelModels,
      heuristicConflictOrdering: settings.heuristicConflictOrdering,
      skipAlreadyFixed: settings.skipAlreadyFixed,
      skipDuplicates: settings.skipDuplicates,
      verifyBeforeFix: settings.verifyBeforeFix,
      priority: settings.priority,
      actionRef: actionRef.ref,
      actionRefComment: actionRef.comment,
    });

    const outDir =
      options.outDir ?? join(process.cwd(), "fixowl-manual", `${ref.owner}-${ref.repo}`);
    const files: Array<{ path: string; content: string }> = [
      { path: WORKFLOW_PATH, content: workflow },
      { path: REPO_CONFIG_PATH, content: STARTER_REPO_CONFIG },
      { path: STARTER_ISSUE_TEMPLATE_PATH, content: STARTER_ISSUE_TEMPLATE },
    ];
    for (const file of files) {
      const dest = join(outDir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.content);
    }
    log.ok(`wrote ${files.length} files under ${outDir}`);

    const labels = [
      ...labelsInRule(settings.labels),
      ...Object.keys(settings.labelModels),
      ...priorityLabelsToEnsure(settings.priority),
    ];
    const secretNames = [
      APP_ID_SECRET,
      APP_INSTALLATION_ID_SECRET,
      APP_PRIVATE_KEY_SECRET,
      ...adapter.env,
    ];

    log.info(renderManualSteps({ repoFullName, outDir, files, labels, secretNames, cloudRunner }));
  }
}

function renderManualSteps(params: {
  repoFullName: string;
  outDir: string;
  files: Array<{ path: string }>;
  labels: string[];
  secretNames: string[];
  cloudRunner: boolean;
}): string {
  const { repoFullName, outDir, files, labels, secretNames, cloudRunner } = params;
  const labelCmds = labels
    .map(
      (name) =>
        `  gh label create "${name}" --repo ${repoFullName} --color ${FIXOWL_LABEL_COLOR} ` +
        `--description "fixowl picks this issue up on the next scheduled run" --force`,
    )
    .join("\n");
  const secretCmds = secretNames
    .map((name) => `  gh secret set ${name} --repo ${repoFullName}`)
    .join("\n");
  return `
Next steps - none of these need an admin token; each uses your own logged-in
\`gh\`/GitHub session or the repo Settings UI:

1. Labels (create the ones fixowl watches for):
${labelCmds}

2. Secrets (names only - \`gh secret set\` prompts for the value, or use repo
   Settings > Secrets and variables > Actions):
${secretCmds}
   ${APP_ID_SECRET}/${APP_INSTALLATION_ID_SECRET}/${APP_PRIVATE_KEY_SECRET} come from your
   GitHub App (see docs/app-auth.md); the rest are your agent's own credential.

3. Files (already rendered for you under ${outDir}):
${files.map((f) => `  ${f.path}`).join("\n")}
   Copy them into ${repoFullName} on a branch and open a PR (edit .fixowl.yml's
   verify commands for this repo first). Never commit the workflow straight to
   the default branch - review it like any other CI change.

4. ${
    cloudRunner
      ? `Runner: none to set up. This repo is configured github-hosted, so the
   workflow runs on GitHub's \`ubuntu-latest\` cloud runner and nothing runs on
   your machine.`
      : `Runner: register a self-hosted runner from the GitHub UI (Settings > Actions
   > Runners > New self-hosted runner) and follow the printed commands, or run
   \`fixowl start --register\` once with a short-lived admin token you revoke
   immediately after. Then \`fixowl start\` needs no admin token at all.`
  }
`;
}
