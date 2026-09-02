import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./repo-provisioning.ts";

export interface RunnerInfo {
  id: number;
  name: string;
  status: string;
  busy: boolean;
}

/** Registration tokens expire after 1 hour; always fetch fresh, never store. */
export async function getRegistrationToken(octokit: Octokit, ref: RepoRef): Promise<string> {
  const { data } = await octokit.rest.actions.createRegistrationTokenForRepo({ ...ref });
  return data.token;
}

export async function getRemovalToken(octokit: Octokit, ref: RepoRef): Promise<string> {
  const { data } = await octokit.rest.actions.createRemoveTokenForRepo({ ...ref });
  return data.token;
}

export async function listRunners(octokit: Octokit, ref: RepoRef): Promise<RunnerInfo[]> {
  const { data } = await octokit.rest.actions.listSelfHostedRunnersForRepo({
    ...ref,
    per_page: 100,
  });
  return data.runners.map((runner) => ({
    id: runner.id,
    name: runner.name,
    status: runner.status,
    busy: runner.busy,
  }));
}

export async function findRunner(
  octokit: Octokit,
  ref: RepoRef,
  name: string,
): Promise<RunnerInfo | undefined> {
  return (await listRunners(octokit, ref)).find((runner) => runner.name === name);
}

export async function deleteRunner(octokit: Octokit, ref: RepoRef, id: number): Promise<void> {
  await octokit.rest.actions.deleteSelfHostedRunnerFromRepo({ ...ref, runner_id: id });
}

export function runnerNameFor(repoFullName: string): string {
  return `fixowl-${repoFullName.replace("/", "-").toLowerCase()}`.slice(0, 64);
}
