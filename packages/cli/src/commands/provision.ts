import {
  APP_ID_SECRET,
  APP_INSTALLATION_ID_SECRET,
  APP_PRIVATE_KEY_SECRET,
  getAgentAdapter,
  labelsInRule,
  priorityLabelsToEnsure,
  renderFixowlWorkflow,
  resolveRepoSettings,
  runnerBaseDir,
  workflowHasSchedule,
  STARTER_ISSUE_TEMPLATE,
  STARTER_ISSUE_TEMPLATE_PATH,
  STARTER_REPO_CONFIG,
  REPO_CONFIG_PATH,
  WORKFLOW_PATH,
} from "@fixowl/core";
import { ACTION_REPO, targetRepos, type CliContext } from "../context.ts";
import { resolvePrivateKey, toPkcs8Pem } from "../github/app-key.ts";
import {
  branchExists,
  createBranch,
  ensureLabels,
  fileExists,
  openPullRequest,
  putRepoSecret,
  PRIORITY_LABEL_META,
  resolveActionRef,
  SELECTOR_LABEL_META,
  splitRepoFullName,
  upsertFile,
} from "../github/repo-provisioning.ts";
import { log } from "../log.ts";
import { runnerDirFor } from "../runner/install.ts";
import { registerRunner, type RegisterRunnerParams } from "../runner/register.ts";

export interface ProvisionOptions {
  noSchedule?: boolean;
  /**
   * Skip registering the runner on this machine. Use it when you provision from
   * a different host than the one that runs the runner (register there with
   * `fixowl start --register`). Defaults to registering here.
   */
  noRegister?: boolean;
  /** Override for tests; defaults to the real registration flow. */
  registerRunner?: (params: RegisterRunnerParams) => Promise<"configured" | "already">;
}

/**
 * A pull request provisioning opened (or found already open) that the operator
 * still has to act on. `workflow` is REQUIRED - scheduled runs stay inert until
 * it is merged onto the default branch, so `fixowl init` blocks on it before it
 * offers to start the runner. `starter-files` is optional (the operator edits
 * the verify commands, then merges when ready).
 */
export interface ProvisionedPr {
  /** owner/repo the PR belongs to. */
  repo: string;
  kind: "workflow" | "starter-files";
  /** Full https://github.com/... URL. */
  url: string;
}

/** What `provisionCommand` opened that the operator must still merge. */
export interface ProvisionResult {
  prs: ProvisionedPr[];
}

export async function provisionCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const prs: ProvisionedPr[] = [];
  const actionRef = await resolveActionRef(ctx.admin, ACTION_REPO);
  for (const repoFullName of targetRepos(ctx.config, repoArg)) {
    log.info(`\nprovisioning ${repoFullName}`);
    const ref = splitRepoFullName(repoFullName);
    const settings = resolveRepoSettings(ctx.config, repoFullName);
    const adapter = getAgentAdapter(settings.agent, settings.agentEnv);
    if (adapter.name === "script") {
      throw new Error(
        `repo ${repoFullName} is configured with the test-only "script" agent, which executes ` +
          `issue bodies as shell; refusing to provision it`,
      );
    }
    const { data: repoData } = await ctx.admin.rest.repos.get({ ...ref });
    const defaultBranch = repoData.default_branch;

    // 1. Labels: issue-pickup labels plus the model-selector labels. Selector
    // labels get their own description/color - they choose a model + effort,
    // they do not cause pickup.
    const selectorLabels = Object.keys(settings.labelModels);
    const created = [
      ...(await ensureLabels(ctx.admin, ref, labelsInRule(settings.labels))),
      ...(await ensureLabels(ctx.admin, ref, selectorLabels, SELECTOR_LABEL_META)),
      // Priority labels (empty unless the repo opted into priority selection) so a
      // ranked pickup label always exists to apply. Ranking labels, not pickup.
      ...(await ensureLabels(
        ctx.admin,
        ref,
        priorityLabelsToEnsure(settings.priority),
        PRIORITY_LABEL_META,
      )),
    ];
    log.ok(created.length > 0 ? `labels created: ${created.join(", ")}` : "labels already present");

    // 2. Secrets: the GitHub App runtime-credential trio plus every agent env
    // var, sealed client-side with the admin token (the only token holding
    // Secrets: write - the admin-token-is-setup-only invariant).
    const runtimeSecretNames = await sealRuntimeCredential(ctx, ref);
    for (const name of adapter.env) {
      const value = ctx.secrets[name] ?? process.env[name];
      if (value === undefined || value === "") {
        throw new Error(
          `agent env var ${name} is not in secrets.env; cannot provision ${repoFullName}`,
        );
      }
      await putRepoSecret(ctx.admin, ref, name, value);
    }
    log.ok(`secrets sealed and pushed: ${[...runtimeSecretNames, ...adapter.env].join(", ")}`);

    // 3. Workflow file. The `schedule_trigger` choice (or the legacy
    // --no-schedule flag) decides whether the workflow carries an `on.schedule:`
    // cron: `host-scheduler` mode renders a dispatch-only workflow the host
    // launchd agent drives directly (issue #81), `github-cron`/`both` keep the cron.
    const includeSchedule = !options.noSchedule && workflowHasSchedule(settings.scheduleTrigger);
    // The runner mode picks the workflow's `runs-on`: the self-hosted runner this
    // host registers, or GitHub's cloud `ubuntu-latest` (the one-line cloud move).
    const cloudRunner = settings.runnerMode === "github-hosted";
    const workflow = renderFixowlWorkflow({
      runsOn: cloudRunner ? "ubuntu-latest" : undefined,
      schedule: includeSchedule ? settings.schedule : null,
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
    // The workflow controls what runs on the self-hosted runner, so - like the
    // starter files below - it is *always* proposed via PR, never committed
    // straight to the default branch. Reusing an existing provision branch is
    // safe: upsertFile updates it in place and openPrIfMissing reuses its open
    // PR, so re-running provision refreshes the pending workflow PR.
    const workflowBranch = "fixowl/provision-workflow";
    if (!(await branchExists(ctx.admin, ref, workflowBranch))) {
      await createBranch(ctx.admin, ref, workflowBranch, defaultBranch);
    }
    const result = await upsertFile(ctx.admin, ref, {
      path: WORKFLOW_PATH,
      content: workflow,
      message: "chore: fixowl workflow",
      branch: workflowBranch,
    });
    if (result.action === "unchanged") {
      log.ok("workflow already up to date on the provision branch");
      // The branch may still carry an open, unmerged PR from a prior run; if so,
      // surface it as a required action rather than dropping it.
      const url = await findOpenPrUrl(ctx, ref, workflowBranch);
      if (url !== undefined) prs.push({ repo: repoFullName, kind: "workflow", url });
    } else {
      const url = await openPrIfMissing(ctx, ref, {
        head: workflowBranch,
        base: defaultBranch,
        title: "chore: fixowl workflow",
        body:
          "Adds or updates the fixowl workflow. Generated by `fixowl provision`. " +
          "Merge this PR to activate scheduled runs; the runner does not act on an unmerged workflow.",
      });
      log.ok(`workflow ${result.action} via PR: ${url}`);
      log.warn(
        "merge the workflow PR to activate scheduled runs (the runner ignores it until then)",
      );
      prs.push({ repo: repoFullName, kind: "workflow", url });
    }

    // 4. Starter repo files, proposed via PR so maintainers stay in the loop
    const missing: Array<{ path: string; content: string }> = [];
    if (!(await fileExists(ctx.admin, ref, REPO_CONFIG_PATH))) {
      missing.push({ path: REPO_CONFIG_PATH, content: STARTER_REPO_CONFIG });
    }
    if (!(await fileExists(ctx.admin, ref, STARTER_ISSUE_TEMPLATE_PATH))) {
      missing.push({ path: STARTER_ISSUE_TEMPLATE_PATH, content: STARTER_ISSUE_TEMPLATE });
    }
    if (missing.length === 0) {
      log.ok("starter files already present (.fixowl.yml, issue template)");
    } else {
      const branch = "fixowl/provision-files";
      if (await branchExists(ctx.admin, ref, branch)) {
        log.warn(`branch ${branch} already exists; review or delete its PR first`);
        const url = await findOpenPrUrl(ctx, ref, branch);
        if (url !== undefined) prs.push({ repo: repoFullName, kind: "starter-files", url });
      } else {
        await createBranch(ctx.admin, ref, branch, defaultBranch);
        for (const file of missing) {
          await upsertFile(ctx.admin, ref, {
            path: file.path,
            content: file.content,
            message: `chore: add ${file.path} for fixowl`,
            branch,
          });
        }
        const url = await openPrIfMissing(ctx, ref, {
          head: branch,
          base: defaultBranch,
          title: "chore: fixowl starter files",
          body:
            "Starter `.fixowl.yml` and issue template for fixowl. " +
            "Edit the verify commands for this repo before merging.",
        });
        log.ok(`starter files proposed: ${url} (${missing.map((f) => f.path).join(", ")})`);
        prs.push({ repo: repoFullName, kind: "starter-files", url });
      }
    }

    // 5. Register the self-hosted runner on THIS host. This is where the admin
    // token's Administration: write is spent; after this the token can be
    // revoked (or downgraded to read-only) and routine `fixowl start` still
    // works. Skip with --no-register when provisioning from a different host
    // than the one that runs the runner (register there with
    // `fixowl start --register`).
    if (cloudRunner) {
      log.info(
        "skipping runner registration (github-hosted runner); the workflow runs on GitHub's ubuntu-latest cloud runner, so nothing runs on this machine",
      );
    } else if (options.noRegister === true) {
      log.info(
        "skipping runner registration (--no-register); register on the runner host with `fixowl start --register`",
      );
    } else {
      const register = options.registerRunner ?? registerRunner;
      const dir = runnerDirFor(runnerBaseDir(ctx.config), repoFullName);
      await register({ admin: ctx.admin, ref, dir, repoFullName });
    }

    if (repoData.private === false && includeSchedule) {
      log.warn(
        "public repo: GitHub pauses scheduled workflows after 60 days without repo activity; `fixowl status` reminds you",
      );
    }
  }
  return { prs };
}

/**
 * Seal the repo's GitHub App runtime credential and return the secret names
 * sealed. The private key is normalized to PKCS#8 first (GitHub hands out
 * PKCS#1; the action's WebCrypto-based auth needs PKCS#8).
 */
async function sealRuntimeCredential(
  ctx: CliContext,
  ref: { owner: string; repo: string },
): Promise<string[]> {
  const app = ctx.config.github.app;
  await putRepoSecret(ctx.admin, ref, APP_ID_SECRET, String(app.app_id));
  await putRepoSecret(ctx.admin, ref, APP_INSTALLATION_ID_SECRET, String(app.installation_id));
  await putRepoSecret(
    ctx.admin,
    ref,
    APP_PRIVATE_KEY_SECRET,
    toPkcs8Pem(resolvePrivateKey(app.private_key)),
  );
  return [APP_ID_SECRET, APP_INSTALLATION_ID_SECRET, APP_PRIVATE_KEY_SECRET];
}

async function openPrIfMissing(
  ctx: CliContext,
  ref: { owner: string; repo: string },
  params: { head: string; base: string; title: string; body: string },
): Promise<string> {
  const existing = await findOpenPrUrl(ctx, ref, params.head);
  if (existing !== undefined) return existing;
  return await openPullRequest(ctx.admin, ref, params);
}

/** The URL of the open PR whose head is `head`, or undefined when none is open. */
async function findOpenPrUrl(
  ctx: CliContext,
  ref: { owner: string; repo: string },
  head: string,
): Promise<string | undefined> {
  const { data } = await ctx.admin.rest.pulls.list({
    ...ref,
    state: "open",
    head: `${ref.owner}:${head}`,
  });
  return data[0]?.html_url;
}
