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
/** A distinct blue for selector labels, so they read differently from pickup labels. */
export const FIXOWL_SELECTOR_LABEL_COLOR = "1d76db";
/** A distinct amber for priority labels, so they read differently again. */
export const FIXOWL_PRIORITY_LABEL_COLOR = "d93f0b";

/** Metadata a pickup label carries when fixowl creates it. */
export const PICKUP_LABEL_META: LabelMeta = {
  color: FIXOWL_LABEL_COLOR,
  description: "fixowl picks this issue up on the next scheduled run",
};

/**
 * Metadata a model/effort selector label carries. A selector label does not
 * cause pickup; it only chooses the model + reasoning effort once an issue is
 * already selected, so it gets its own description and color.
 */
export const SELECTOR_LABEL_META: LabelMeta = {
  color: FIXOWL_SELECTOR_LABEL_COLOR,
  description: "fixowl runs this issue with a specific model + reasoning effort",
};

/**
 * Metadata a priority label carries. A priority label does not cause pickup; it
 * ranks a pickup-labeled issue so fixowl fills the run cap highest-priority-first.
 */
export const PRIORITY_LABEL_META: LabelMeta = {
  color: FIXOWL_PRIORITY_LABEL_COLOR,
  description: "fixowl fills the nightly run cap by priority, highest first",
};

/** The color + description fixowl stamps on a label it creates. */
export interface LabelMeta {
  color: string;
  description: string;
}

/**
 * Idempotently ensures every named label exists, creating any that are missing
 * with the given metadata (defaults to the pickup-label look). Returns the
 * names it actually created.
 */
export async function ensureLabels(
  octokit: Octokit,
  ref: RepoRef,
  labels: readonly string[],
  meta: LabelMeta = PICKUP_LABEL_META,
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
        color: meta.color,
        description: meta.description,
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

/** A resolved `uses:` ref plus the `# ...` comment that names what it points at. */
export interface ResolvedActionRef {
  ref: string;
  comment: string;
}

/**
 * How the operator wants the workflow's fixowl action pinned. A single
 * per-provision-run choice (every repo in the run pins the same version):
 *
 * - `cli-release` - the release this CLI is built from, so the action matches
 *   the CLI by default. Resolves the `v<cliVersion>` tag to its immutable SHA;
 *   if no such tag is published (a base version with no `-rc.N` tag, or a local
 *   dev build) it degrades to main HEAD rather than hard-failing.
 * - `tag` - a specific release / RC tag the operator typed. Resolved to its
 *   immutable SHA; a tag that does not exist is a hard error (no silent
 *   fallback - it is an explicit operator request).
 * - `main` - the moving `@main` ref, the deliberate exception to SHA-pinning,
 *   for always-latest tracking (e.g. fixowl's own self-run repo).
 */
export type ActionVersionChoice =
  | { kind: "cli-release"; cliVersion: string }
  | { kind: "tag"; tag: string }
  | { kind: "main" };

/**
 * Resolves the fixowl action ref the workflow pins, per the operator's
 * `ActionVersionChoice`. Immutable-SHA-pins for `cli-release` and `tag`; `main`
 * alone is a moving ref. Keeps the "fail rather than silently pin a mutable
 * ref" spirit for the tag paths: a typed tag that does not exist is a hard
 * error, and the `cli-release` fallback to main HEAD is only for a version with
 * no matching published tag (dev/source builds).
 */
export async function resolveActionRef(
  octokit: Octokit,
  actionRepo: string,
  choice: ActionVersionChoice,
): Promise<ResolvedActionRef> {
  const { owner, repo } = splitRepoFullName(actionRepo);
  switch (choice.kind) {
    case "main":
      // The one moving-ref exception to SHA-pinning. A frozen main-HEAD SHA is
      // exactly what goes stale, so `@main` is left mutable on purpose: it must
      // always resolve to the current tip of main at run time.
      return { ref: `${actionRepo}@main`, comment: "main (tracks latest)" };
    case "tag": {
      const sha = await resolveTagSha(octokit, owner, repo, choice.tag);
      if (sha === undefined) {
        throw new Error(
          `fixowl action tag "${choice.tag}" was not found in ${actionRepo}. ` +
            `Pick an existing release/RC tag (see https://github.com/${actionRepo}/releases), ` +
            `or choose "main" to track the latest.`,
        );
      }
      return { ref: `${actionRepo}@${sha}`, comment: choice.tag };
    }
    case "cli-release": {
      const tag = `v${choice.cliVersion}`;
      const sha = await resolveTagSha(octokit, owner, repo, tag);
      if (sha !== undefined) return { ref: `${actionRepo}@${sha}`, comment: tag };
      // Dev/source-build fallback (DEFAULT choice only): this CLI's version has
      // no matching published tag, so degrade to main HEAD - today's behavior -
      // with a note, instead of hard-failing. A typed tag still hard-fails above.
      return resolveMainHeadSha(octokit, actionRepo, owner, repo, tag);
    }
  }
}

/**
 * Resolves a tag (or annotated tag) to its commit SHA via the same public read
 * the rest of provisioning uses. Returns undefined when the tag does not exist
 * so callers can decide between hard-fail (typed tag) and fallback (default).
 */
async function resolveTagSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: tag });
    return data.sha;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Resolves main HEAD to a frozen SHA (the pre-choice default behavior). */
async function resolveMainHeadSha(
  octokit: Octokit,
  actionRepo: string,
  owner: string,
  repo: string,
  missingTag: string,
): Promise<ResolvedActionRef> {
  try {
    const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: "HEAD" });
    return {
      ref: `${actionRepo}@${data.sha}`,
      comment: `main @ ${new Date().toISOString().slice(0, 10)} (no ${missingTag} tag; dev/source build)`,
    };
  } catch (error) {
    throw new Error(
      `could not resolve ${actionRepo} HEAD for SHA-pinning the action ref: ${String(error)}`,
      { cause: error },
    );
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
