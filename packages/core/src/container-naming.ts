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

/** `fixowl-` plus the trailing `-` of {@link containerNamePrefix}. */
const FIXED_PREFIX_LENGTH = "fixowl-".length + 1;
/** The widest issue token: `classify`, wider than any realistic issue number. */
const ISSUE_TOKEN_BUDGET = "classify".length;
/** Chars always left for `-<purpose>` so a step's purpose never vanishes wholesale. */
const PURPOSE_BUDGET = 1 + 8;
/** Chars appended to an over-budget slug to keep two long repos distinct: `-<hash>`. */
const SLUG_HASH_LENGTH = 1 + 6;

/**
 * The repo slug's own budget, reserved BEFORE the issue and purpose tokens are
 * appended so those always survive: a long repo name can never push the
 * `<issue>-<purpose>` tail past Docker's cap and make every step of every issue
 * share one `--name`. It is a fixed number (not a function of the issue or
 * purpose) so {@link containerNamePrefix} stays a true prefix of every name.
 */
export const CONTAINER_REPO_SLUG_MAX_LENGTH =
  CONTAINER_NAME_MAX_LENGTH - FIXED_PREFIX_LENGTH - ISSUE_TOKEN_BUDGET - PURPOSE_BUDGET;

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

/** FNV-1a in base36 - a short stable digest, not a security primitive. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(0, 6);
}

/**
 * The repo's slug, clipped to {@link CONTAINER_REPO_SLUG_MAX_LENGTH}. An
 * over-budget slug keeps a readable head plus a digest of the full name, so two
 * long repos sharing a common head still get distinct container names (and
 * distinct discovery prefixes) instead of collapsing onto one.
 */
function repoNameSlug(repoFullName: string): string {
  const slug = nameSlug(repoFullName);
  if (slug.length <= CONTAINER_REPO_SLUG_MAX_LENGTH) return slug;
  const head = slug.slice(0, CONTAINER_REPO_SLUG_MAX_LENGTH - SLUG_HASH_LENGTH);
  return `${head}-${shortHash(slug)}`;
}

/**
 * Container names include the repo so two runners for different repos on one
 * host can never collide on `docker run --name` - or worse, have one repo's
 * timeout `docker rm -f` kill the other repo's live container.
 *
 * The repo slug is budgeted first (see {@link CONTAINER_REPO_SLUG_MAX_LENGTH}),
 * so only a long `purpose` is ever clipped by the 63-char cap: the issue token
 * always survives and each (issue, purpose) keeps its own name.
 */
export function containerName(
  repoFullName: string,
  issueNumber: ContainerIssue,
  purpose: string,
): string {
  return `fixowl-${repoNameSlug(repoFullName)}-${issueNumber}-${nameSlug(purpose)}`.slice(
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
  return `fixowl-${repoNameSlug(repoFullName)}-`;
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
