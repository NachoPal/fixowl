import type { Octokit } from "@octokit/rest";
import { sealSecret } from "./secrets-sealing.ts";

export interface RepoRef {
  owner: string;
  repo: string;
}

export function splitRepoFullName(fullName: string): RepoRef {
  const [owner, repo] = fullName.split("/");
  if (owner === undefined || repo === undefined || owner === "" || repo === "") {
    throw new Error(`not an owner/repo name: ${fullName}`);
  }
  return { owner, repo };
}

export const FIXOWL_LABEL_COLOR = "5319e7";

export async function ensureLabels(
  octokit: Octokit,
  ref: RepoRef,
  labels: readonly string[],
): Promise<string[]> {
  const created: string[] = [];
  for (const name of labels) {
    try {
      await octokit.rest.issues.getLabel({ ...ref, name });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await octokit.rest.issues.createLabel({
        ...ref,
        name,
        color: FIXOWL_LABEL_COLOR,
        description: "fixowl picks this issue up on the next scheduled run",
      });
      created.push(name);
    }
  }
  return created;
}

export async function putRepoSecret(
  octokit: Octokit,
  ref: RepoRef,
  name: string,
  value: string,
): Promise<void> {
  const { data: publicKey } = await octokit.rest.actions.getRepoPublicKey({ ...ref });
  await octokit.rest.actions.createOrUpdateRepoSecret({
    ...ref,
    secret_name: name,
    encrypted_value: await sealSecret(publicKey.key, value),
    key_id: publicKey.key_id,
  });
}

export interface FileUpsertResult {
  path: string;
  action: "created" | "updated" | "unchanged";
}

/** Creates or updates one file on a branch via the contents API; no-op when identical. */
export async function upsertFile(
  octokit: Octokit,
  ref: RepoRef,
  params: { path: string; content: string; message: string; branch: string },
): Promise<FileUpsertResult> {
  let existingSha: string | undefined;
  try {
    const { data } = await octokit.rest.repos.getContent({
      ...ref,
      path: params.path,
      ref: params.branch,
    });
    if (!Array.isArray(data) && data.type === "file") {
      const existing = Buffer.from(data.content, "base64").toString("utf8");
      if (existing === params.content) return { path: params.path, action: "unchanged" };
      existingSha = data.sha;
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await octokit.rest.repos.createOrUpdateFileContents({
    ...ref,
    path: params.path,
    message: params.message,
    content: Buffer.from(params.content).toString("base64"),
    branch: params.branch,
    ...(existingSha !== undefined ? { sha: existingSha } : {}),
  });
  return { path: params.path, action: existingSha !== undefined ? "updated" : "created" };
}

export async function fileExists(octokit: Octokit, ref: RepoRef, path: string): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({ ...ref, path });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function branchExists(
  octokit: Octokit,
  ref: RepoRef,
  branch: string,
): Promise<boolean> {
  try {
    await octokit.rest.repos.getBranch({ ...ref, branch });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Creates `branch` off the default branch head. */
export async function createBranch(
  octokit: Octokit,
  ref: RepoRef,
  branch: string,
  fromBranch: string,
): Promise<void> {
  const { data: base } = await octokit.rest.git.getRef({ ...ref, ref: `heads/${fromBranch}` });
  await octokit.rest.git.createRef({ ...ref, ref: `refs/heads/${branch}`, sha: base.object.sha });
}

export async function openPullRequest(
  octokit: Octokit,
  ref: RepoRef,
  params: { head: string; base: string; title: string; body: string },
): Promise<string> {
  const { data } = await octokit.rest.pulls.create({ ...ref, ...params });
  return data.html_url;
}

/** Resolves the fixowl action repo's default-branch head SHA for pinning. */
export async function resolveActionRef(
  octokit: Octokit,
  actionRepo: string,
): Promise<{ ref: string; comment: string }> {
  const { owner, repo } = splitRepoFullName(actionRepo);
  try {
    const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: "HEAD" });
    return {
      ref: `${actionRepo}@${data.sha}`,
      comment: `main @ ${new Date().toISOString().slice(0, 10)}`,
    };
  } catch {
    return { ref: `${actionRepo}@main`, comment: "unpinned: could not resolve HEAD sha" };
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}
