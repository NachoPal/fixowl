import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Exec, ExecResult } from "./deps.ts";

/**
 * All git happens on the host (the runner), outside any container: the coding
 * agent never sees a GitHub token. Two structural rules keep it that way.
 *
 * 1. The git dir never enters a container. `extractGitDir` moves `.git` to a
 *    sibling of the workspace for the whole night, so agent and verification
 *    containers mount a git-less working tree. Every host git command names
 *    the external git dir explicitly (`--git-dir`), never relying on
 *    discovery, so a `.git` a hostile agent plants in the mounted workspace
 *    is inert: its hooks, `core.fsmonitor`, or rewritten remote URLs never
 *    execute on the host. Planted `.git` entries are deleted at every branch
 *    switch and again when the git dir is restored at the end of the night.
 *
 * 2. The credential never touches disk. The runtime PAT is injected per git
 *    command as an env-based `http.extraheader`, which keeps it out of argv
 *    (`ps`), out of git error messages, and out of every file in the git dir
 *    and the workspace (no remote URLs with tokens, no credential helpers).
 */

/** Sibling path the git dir lives at while containers can see the workspace. */
export function hostGitDirFor(workspaceDir: string): string {
  const normalized = resolve(workspaceDir);
  return join(dirname(normalized), `${basename(normalized)}.fixowl-git`);
}

/**
 * Moves `.git` out of the workspace for the night. If a previous run was
 * killed after extracting, the already-extracted dir is reused; a stale
 * extracted dir next to a fresh checkout is discarded first.
 */
export function extractGitDir(workspaceDir: string): string {
  const inWorkspace = join(resolve(workspaceDir), ".git");
  const hostGitDir = hostGitDirFor(workspaceDir);
  if (!existsSync(inWorkspace)) {
    if (existsSync(hostGitDir)) return hostGitDir;
    throw new Error(`${inWorkspace} not found; the workspace must be a git checkout`);
  }
  rmSync(hostGitDir, { recursive: true, force: true });
  renameSync(inWorkspace, hostGitDir);
  return hostGitDir;
}

/** Puts the git dir back at `.git`, deleting any `.git` an agent planted. */
export function restoreGitDir(workspaceDir: string, gitDir: string): void {
  if (!existsSync(gitDir)) return;
  const inWorkspace = join(resolve(workspaceDir), ".git");
  rmSync(inWorkspace, { recursive: true, force: true });
  renameSync(gitDir, inWorkspace);
}

export class GitWorkspace {
  constructor(
    private readonly exec: Exec,
    private readonly dir: string,
    private readonly gitDir: string,
    private readonly token?: string,
  ) {}

  private authEnv(): Record<string, string> | undefined {
    if (this.token === undefined) return undefined;
    const basic = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }

  /** Explicit --git-dir/--work-tree so git never discovers a planted workspace `.git`. */
  private baseArgv(): string[] {
    return ["git", "--git-dir", this.gitDir, "--work-tree", this.dir];
  }

  private async git(...argv: string[]): Promise<ExecResult> {
    const result = await this.exec.run([...this.baseArgv(), ...argv], {
      cwd: this.dir,
      env: this.authEnv(),
    });
    if (result.code !== 0) {
      throw new Error(
        `git ${argv[0]} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result;
  }

  /**
   * Deletes any `.git` a container left in the working tree. It is inert
   * either way (host git never reads it), but it must not leak into later
   * containers, docker build contexts, or the restored checkout.
   */
  dropPlantedGitDir(): void {
    const planted = join(resolve(this.dir), ".git");
    if (planted === this.gitDir) return; // never the real git dir
    rmSync(planted, { recursive: true, force: true });
  }

  async configureIdentity(): Promise<void> {
    await this.git("config", "user.name", "fixowl");
    await this.git("config", "user.email", "fixowl-bot@users.noreply.github.com");
    // Unattended commits must never wait on the host's signing setup
    // (a global commit.gpgsign with a hardware key would hang the night run).
    await this.git("config", "commit.gpgsign", "false");
    await this.git("config", "tag.gpgsign", "false");
  }

  async listRemoteIssueBranches(): Promise<string[]> {
    const result = await this.git("ls-remote", "--heads", "origin", "refs/heads/issue/*");
    return result.stdout
      .split("\n")
      .map((line) => line.split("\t")[1])
      .filter((ref): ref is string => ref !== undefined && ref !== "")
      .map((ref) => ref.replace("refs/heads/", ""));
  }

  async checkoutNewBranch(branch: string, baseRef: string): Promise<void> {
    this.dropPlantedGitDir();
    await this.git("checkout", "-B", branch, baseRef);
  }

  /**
   * Fetch one remote branch into its `origin/<branch>` tracking ref so it can be
   * used as a base for stacking (issue #48). The initial `fetch-depth: 0`
   * checkout already brings every branch, but an in-flight prerequisite branch
   * pushed on a prior night is fetched explicitly here so the base always
   * resolves regardless of how the workspace was set up.
   */
  async fetchRemoteBranch(branch: string): Promise<void> {
    await this.git("fetch", "origin", `${branch}:refs/remotes/origin/${branch}`);
  }

  async checkout(ref: string): Promise<void> {
    await this.git("checkout", ref);
  }

  async discardAllChanges(): Promise<void> {
    this.dropPlantedGitDir();
    await this.git("reset", "--hard", "HEAD");
    await this.git("clean", "-fd");
  }

  async headSha(): Promise<string> {
    return (await this.git("rev-parse", "HEAD")).stdout.trim();
  }

  async hasChangesAgainst(baseRef: string): Promise<boolean> {
    const status = (await this.git("status", "--porcelain")).stdout.trim();
    if (status !== "") return true;
    const ahead = (await this.git("rev-list", "--count", `${baseRef}..HEAD`)).stdout.trim();
    return Number(ahead) > 0;
  }

  /**
   * One commit `fix #<n>: <title>`. The agent cannot commit on its own (the
   * git dir is outside its container), so changes in the tree always land
   * here; the staged-emptiness check only guards the degenerate no-op case.
   */
  async commitAll(message: string): Promise<void> {
    await this.git("add", "-A");
    const staged = await this.exec.run([...this.baseArgv(), "diff", "--cached", "--quiet"], {
      cwd: this.dir,
    });
    if (staged.code !== 0) {
      await this.git("commit", "-m", message);
    }
  }

  async push(branch: string): Promise<void> {
    await this.git("push", "origin", `${branch}:refs/heads/${branch}`);
  }
}
