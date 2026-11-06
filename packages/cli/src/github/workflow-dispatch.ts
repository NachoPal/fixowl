import type { Octokit } from "@octokit/rest";
import { toWorkflowRunLite, type WorkflowRunLite } from "@fixowl/core";
import type { RepoRef } from "./repo-provisioning.ts";

/**
 * The shared GitHub edge for "poke the target repo's fixowl workflow": the
 * workflow file name provisioning writes, the default-branch read every
 * dispatch needs as its `ref`, and the run-list read the host scheduler's
 * decision takes. `fixowl run` and `fixowl host-scheduler check` both go
 * through here so the pair can never drift (and so the run mapping stays the
 * one in core, shared with the action's `GitHubApi`).
 */

/** The workflow file `fixowl provision` renders into every target repo. */
export const FIXOWL_WORKFLOW_ID = "fixowl.yml";

/** The repo's default branch - the `ref` a workflow_dispatch must target. */
export async function getDefaultBranch(octokit: Octokit, ref: RepoRef): Promise<string> {
  const { data } = await octokit.rest.repos.get({ ...ref });
  return data.default_branch;
}

/** Dispatches the fixowl workflow on `branch`, optionally tagging its source. */
export async function dispatchFixowlWorkflow(
  octokit: Octokit,
  ref: RepoRef,
  branch: string,
  inputs?: Record<string, string>,
): Promise<void> {
  await octokit.rest.actions.createWorkflowDispatch({
    ...ref,
    workflow_id: FIXOWL_WORKFLOW_ID,
    ref: branch,
    ...(inputs === undefined ? {} : { inputs }),
  });
}

/** The repo's most recent fixowl runs, reduced to what the pure decisions read. */
export async function listRecentFixowlRuns(
  octokit: Octokit,
  ref: RepoRef,
  perPage: number,
): Promise<WorkflowRunLite[]> {
  const { data } = await octokit.rest.actions.listWorkflowRuns({
    ...ref,
    workflow_id: FIXOWL_WORKFLOW_ID,
    per_page: perPage,
  });
  return data.workflow_runs.map(toWorkflowRunLite);
}
