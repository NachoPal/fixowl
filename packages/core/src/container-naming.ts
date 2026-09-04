/**
 * Canonical names for the per-step Docker containers fixowl runs (one
 * `docker run --rm --name <name>` per coding-agent / classifier / verify step).
 * This is the single source of truth for the `fixowl-…` name shape: the action
 * builds names with {@link containerName}; the CLI discovers live containers by
 * {@link containerNamePrefix} and reads them back with {@link parseContainerName}.
 * Keep the format here so a change can never silently drift between the two.
 */

/** Docker's own limit on a `--name`; longer names are rejected, so we clip to it. */
export const CONTAINER_NAME_MAX_LENGTH = 63;

/** The `classify` step has no issue number of its own. */
export type ContainerIssue = number | "classify";

export interface ParsedContainerName {
  /** The issue number, or "classify" for the same-files classifier. */
  issue: ContainerIssue;
  /**
   * The step purpose - `agent`, `classify`, `check-<name>`, `web-<name>`. It
   * may be clipped when the 63-char cap truncated the name (see `truncated`).
   */
  purpose: string;
  /**
   * True when the name sits exactly on the 63-char cap, so its trailing
   * `purpose` may have been cut off. The `issue` always precedes `purpose`, so
   * it survives truncation and stays trustworthy.
   */
  truncated: boolean;
}

function nameSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Container names include the repo so two runners for different repos on one
 * host can never collide on `docker run --name` - or worse, have one repo's
 * timeout `docker rm -f` kill the other repo's live container.
 */
export function containerName(
  repoFullName: string,
  issueNumber: ContainerIssue,
  purpose: string,
): string {
  return `fixowl-${nameSlug(repoFullName)}-${issueNumber}-${nameSlug(purpose)}`.slice(
    0,
    CONTAINER_NAME_MAX_LENGTH,
  );
}

/**
 * The shared prefix of every container name for one repo. `docker ps --filter
 * name=<prefix>` narrows discovery to this repo's live steps, and stripping it
 * off a name leaves `<issue>-<purpose>` for {@link parseContainerName}.
 */
export function containerNamePrefix(repoFullName: string): string {
  return `fixowl-${nameSlug(repoFullName)}-`;
}

function parseIssueToken(token: string): ContainerIssue | undefined {
  if (token === "classify") return "classify";
  return /^\d+$/.test(token) ? Number(token) : undefined;
}

/**
 * Reads a live container's name back into (issue, purpose) for the given repo,
 * or `undefined` when the name is not this repo's (a wrong prefix, or a token
 * where the issue number should be). Tolerates the 63-char truncation edge: the
 * issue number always precedes the purpose, so a clipped trailing purpose still
 * yields the issue with `truncated: true`.
 */
export function parseContainerName(
  name: string,
  repoFullName: string,
): ParsedContainerName | undefined {
  const prefix = containerNamePrefix(repoFullName);
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  const truncated = name.length >= CONTAINER_NAME_MAX_LENGTH;
  const dash = rest.indexOf("-");
  if (dash === -1) {
    // The purpose was clipped away entirely; surface the issue we can still read.
    const issue = parseIssueToken(rest);
    return issue === undefined ? undefined : { issue, purpose: "", truncated };
  }
  const issue = parseIssueToken(rest.slice(0, dash));
  if (issue === undefined) return undefined;
  return { issue, purpose: rest.slice(dash + 1), truncated };
}
