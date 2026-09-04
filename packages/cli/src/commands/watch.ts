import { containerNamePrefix, parseContainerName, type ContainerIssue } from "@fixowl/core";
import { targetRepos, type CliContext } from "../context.ts";
import { checkDockerEngine } from "../docker/engine-check.ts";
import { run } from "../exec.ts";
import { log } from "../log.ts";
import { createPrompter } from "../prompt.ts";

/** One live fixowl step container, discovered from `docker ps`. */
export interface LiveContainer {
  /** The `docker` `--name`, used verbatim for `docker logs`. */
  name: string;
  /** The repo this container belongs to (the scope it was discovered under). */
  repoFullName: string;
  issue: ContainerIssue;
  /** The step purpose - `agent`, `classify`, `check-<name>`, `web-<name>`. */
  purpose: string;
  /** `docker ps` status column, e.g. `Up 2 minutes`. */
  status: string;
  /** True when the 63-char name cap may have clipped the purpose. */
  truncated: boolean;
}

export interface WatchOptions {
  /** `--issue <n>`: select the container(s) for one issue (`classify` allowed). */
  issue?: string;
  /** `--container <name>`: select one container by its exact docker name. */
  container?: string;
  /** `--follow` / `--no-follow`: stream live (default) vs. a one-shot snapshot. */
  follow: boolean;
}

const PS_SEPARATOR = "\t";

/** `docker ps` argv scoped to one repo's live fixowl containers. */
export function psArgv(prefix: string): string[] {
  return [
    "docker",
    "ps",
    "--no-trunc",
    "--filter",
    `name=${prefix}`,
    "--format",
    `{{.Names}}${PS_SEPARATOR}{{.Status}}`,
  ];
}

/** `docker logs` argv; `-f` streams until the (--rm) container is removed. */
export function logsArgv(name: string, follow: boolean): string[] {
  return follow ? ["docker", "logs", "-f", name] : ["docker", "logs", name];
}

/** Parses `{{.Names}}\t{{.Status}}` lines into rows, dropping blanks/malformed. */
export function parsePsOutput(stdout: string): Array<{ name: string; status: string }> {
  const rows: Array<{ name: string; status: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const sep = line.indexOf(PS_SEPARATOR);
    if (sep === -1) continue;
    const name = line.slice(0, sep).trim();
    const status = line.slice(sep + 1).trim();
    if (name === "") continue;
    rows.push({ name, status });
  }
  return rows;
}

/**
 * Attributes one discovered container to the configured repo it belongs to.
 *
 * `docker ps --filter name=<prefix>` is a substring match, so one repo's prefix
 * over-matches a sibling whose slug extends it (`fixowl-acme-widgets-` also
 * matches `fixowl-acme-widgets-2-7-agent`). Disambiguate by the LONGEST matching
 * configured-repo prefix, so that container is attributed to `acme/widgets-2`
 * (issue 7) rather than `acme/widgets` (a bogus issue 2). Returns undefined when
 * no configured repo's prefix matches, or the remainder does not parse.
 */
export function attributeContainer(
  row: { name: string; status: string },
  repos: ReadonlyArray<string>,
): LiveContainer | undefined {
  let bestRepo: string | undefined;
  let bestPrefixLength = -1;
  for (const repo of repos) {
    const prefix = containerNamePrefix(repo);
    if (row.name.startsWith(prefix) && prefix.length > bestPrefixLength) {
      bestRepo = repo;
      bestPrefixLength = prefix.length;
    }
  }
  if (bestRepo === undefined) return undefined;
  const parsed = parseContainerName(row.name, bestRepo);
  if (parsed === undefined) return undefined;
  return {
    name: row.name,
    repoFullName: bestRepo,
    issue: parsed.issue,
    purpose: parsed.purpose,
    status: row.status,
    truncated: parsed.truncated,
  };
}

/**
 * Turns `docker ps` rows into live containers, attributing each to its
 * configured repo by longest-prefix match against the full `repos` set (so
 * prefix-related slugs never cross-contaminate the list) and de-duplicating
 * names that surface under more than one repo's substring filter.
 */
export function toLiveContainers(
  rows: ReadonlyArray<{ name: string; status: string }>,
  repos: ReadonlyArray<string>,
): LiveContainer[] {
  const byName = new Map<string, { name: string; status: string }>();
  for (const row of rows) if (!byName.has(row.name)) byName.set(row.name, row);
  const containers: LiveContainer[] = [];
  for (const row of byName.values()) {
    const container = attributeContainer(row, repos);
    if (container !== undefined) containers.push(container);
  }
  return containers;
}

/** A one-line display step, hinting when the purpose may have been clipped. */
export function describeStep(container: LiveContainer): string {
  if (container.purpose === "") return "(step name clipped)";
  return container.truncated ? `${container.purpose}…` : container.purpose;
}

export type Selection =
  | { kind: "none" }
  | { kind: "one"; container: LiveContainer }
  | { kind: "prompt"; candidates: LiveContainer[] }
  | { kind: "not-found"; message: string };

/**
 * Picks a container from the live set given the non-interactive flags. With no
 * flags: none/one resolve directly, several ask to be prompted. `--container`
 * matches an exact name; `--issue` narrows to one issue (which can still be
 * several steps, e.g. agent + a verify check).
 */
export function selectContainer(
  containers: ReadonlyArray<LiveContainer>,
  options: { issue?: string; container?: string },
): Selection {
  if (options.container !== undefined) {
    const match = containers.find((c) => c.name === options.container);
    return match !== undefined
      ? { kind: "one", container: match }
      : { kind: "not-found", message: `no live fixowl container named "${options.container}"` };
  }
  if (options.issue !== undefined) {
    const wanted = options.issue.trim();
    const matches = containers.filter((c) => String(c.issue) === wanted);
    if (matches.length === 0) {
      return { kind: "not-found", message: `no live fixowl container for issue "${wanted}"` };
    }
    return matches.length === 1
      ? { kind: "one", container: matches[0]! }
      : { kind: "prompt", candidates: matches };
  }
  if (containers.length === 0) return { kind: "none" };
  return containers.length === 1
    ? { kind: "one", container: containers[0]! }
    : { kind: "prompt", candidates: [...containers] };
}

function issueLabel(issue: ContainerIssue): string {
  return issue === "classify" ? "classify" : `#${issue}`;
}

function describeContainer(container: LiveContainer, showRepo: boolean): string {
  const scope = showRepo ? `${container.repoFullName} ` : "";
  return `${scope}${issueLabel(container.issue)} ${describeStep(container)} - ${container.status}`;
}

/** Collects the live fixowl containers across the scoped repos. */
async function listContainers(
  ctx: CliContext,
  repoArg: string | undefined,
  env: Record<string, string> | undefined,
): Promise<LiveContainer[]> {
  const repos = targetRepos(ctx.config, repoArg);
  const rows: Array<{ name: string; status: string }> = [];
  for (const repoFullName of repos) {
    const result = await run(psArgv(containerNamePrefix(repoFullName)), { env });
    if (result.code !== 0) {
      throw new Error(`docker ps failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    rows.push(...parsePsOutput(result.stdout));
  }
  // Attribute against the full repo set so a prefix-related sibling (e.g.
  // acme/widgets vs acme/widgets-2) is never mislabeled, and de-dup names that
  // surfaced under more than one repo's substring filter.
  return toLiveContainers(rows, repos);
}

export async function watchCommand(
  ctx: CliContext,
  repoArg: string | undefined,
  options: WatchOptions,
): Promise<void> {
  const engine = await checkDockerEngine();
  if (!engine.ok) {
    log.info(`no fixowl containers are running (${engine.detail})`);
    return;
  }
  const env = engine.dockerHost !== undefined ? { DOCKER_HOST: engine.dockerHost } : undefined;

  const containers = await listContainers(ctx, repoArg, env);
  const showRepo = new Set(containers.map((c) => c.repoFullName)).size > 1;

  const selection = selectContainer(containers, {
    issue: options.issue,
    container: options.container,
  });

  let chosen: LiveContainer;
  switch (selection.kind) {
    case "none":
      log.info("no fixowl containers are running");
      return;
    case "not-found":
      log.error(selection.message);
      process.exitCode = 1;
      return;
    case "one":
      chosen = selection.container;
      break;
    case "prompt": {
      const prompter = createPrompter();
      try {
        chosen = await prompter.choose(
          "\nSeveral fixowl containers are running. Which one?",
          selection.candidates.map((container) => ({
            value: container,
            label: describeContainer(container, showRepo),
            hint: container.name,
          })),
        );
      } finally {
        prompter.close();
      }
      break;
    }
  }

  log.info(`\nwatching ${chosen.name} (${describeContainer(chosen, showRepo)})`);
  const result = await run(logsArgv(chosen.name, options.follow), { inherit: true, env });
  if (result.code !== null && result.code !== 0) process.exitCode = result.code;
}
