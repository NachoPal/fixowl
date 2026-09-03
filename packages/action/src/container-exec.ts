import type { ContainerEngine, ContainerRunSpec, Exec, ExecResult, Logger } from "./deps.ts";

/** Mount point of the repo checkout inside every container. */
export const WORKSPACE_MOUNT_PATH = "/workspace";

/**
 * Builds the `docker run` argv. Security posture (the structural backstop for
 * prompt injection): no GitHub token, no docker socket, no mounts beyond what
 * is listed, cap-drop ALL, no-new-privileges, pid and memory limits. Env vars
 * are passed as bare `-e NAME` so secret values never appear in argv; the
 * docker client copies them from its own environment.
 */
export function dockerRunArgv(spec: ContainerRunSpec): string[] {
  const argv = [
    "docker",
    "run",
    "--rm",
    "--name",
    spec.name,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "512",
    "--memory",
    "6g",
    "-v",
    `${spec.workspaceDir}:${WORKSPACE_MOUNT_PATH}${spec.workspaceReadOnly ? ":ro" : ""}`,
    "-w",
    WORKSPACE_MOUNT_PATH,
  ];
  if (spec.stdin !== undefined) argv.push("-i");
  for (const mount of spec.extraMounts ?? []) {
    argv.push("-v", `${mount.host}:${mount.container}${mount.readOnly ? ":ro" : ""}`);
  }
  for (const name of Object.keys(spec.env ?? {})) {
    argv.push("-e", name);
  }
  argv.push(spec.image, ...spec.argv);
  return argv;
}

export function dockerBuildArgv(params: {
  image: string;
  dockerfile: string;
  contextDir: string;
}): string[] {
  return ["docker", "build", "-t", params.image, "-f", params.dockerfile, params.contextDir];
}

/**
 * Container names include the repo so two runners for different repos on one
 * host can never collide on `docker run --name` - or worse, have one repo's
 * timeout `docker rm -f` kill the other repo's live container.
 */
export function containerName(
  repoFullName: string,
  issueNumber: number | "classify",
  purpose: string,
): string {
  return `fixowl-${nameSlug(repoFullName)}-${issueNumber}-${nameSlug(purpose)}`.slice(0, 63);
}

function nameSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class DockerEngine implements ContainerEngine {
  constructor(
    private readonly exec: Exec,
    private readonly log: Logger,
  ) {}

  async build(params: {
    image: string;
    dockerfile: string;
    contextDir: string;
  }): Promise<ExecResult> {
    return await this.exec.run(dockerBuildArgv(params), { cwd: params.contextDir });
  }

  async pruneImages(repository: string, keepImage: string): Promise<void> {
    const list = await this.exec.run([
      "docker",
      "images",
      repository,
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ]);
    if (list.code !== 0) return;
    for (const image of list.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.endsWith(":<none>"))) {
      if (image === keepImage) continue;
      const removed = await this.exec.run(["docker", "rmi", image]);
      if (removed.code === 0) this.log.info(`pruned stale image ${image}`);
    }
  }

  async run(spec: ContainerRunSpec): Promise<ExecResult> {
    // Kill the container itself on timeout, not just the docker client:
    // killing the client would leave the container running.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (spec.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        this.log.warn(`container ${spec.name} hit its ${spec.timeoutMs}ms timeout; removing it`);
        void this.exec.run(["docker", "rm", "-f", spec.name]).catch(() => {});
      }, spec.timeoutMs);
    }
    try {
      const result = await this.exec.run(dockerRunArgv(spec), {
        env: spec.env,
        stdin: spec.stdin,
      });
      return timedOut ? { ...result, timedOut: true } : result;
    } finally {
      clearTimeout(timer);
    }
  }
}
