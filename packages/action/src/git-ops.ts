import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type CommitTip, FIXOWL_DEFAULT_GIT_IDENTITY, type GitIdentity } from "@fixowl/core";
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
 * 2. The credential never touches disk. The runtime token is injected per git
 *    command as an env-based `http.extraheader`, which keeps it out of argv
 *    (`ps`), out of git error messages, and out of every file in the git dir
 *    and the workspace (no remote URLs with tokens, no credential helpers). The
 *    token is fetched from a provider callback immediately before each git
 *    command, not captured once, so a GitHub App installation token (which
 *    expires in ~1h) is always current even on a push hours into the night.
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
    /**
     * Resolves the CURRENT runtime token, called immediately before each
     * authenticated git command (never captured once). It asks the octokit App
     * auth strategy, which returns the cached installation token or re-mints a
     * fresh one near expiry.
     * Omitted in tests that push to a local remote needing no auth.
     */
    private readonly tokenProvider?: () => Promise<string> | string,
    /**
     * The commit author/committer identity, resolved at night start from the
     * installed App's real bot account (app-identity.ts::resolveAppBotIdentity)
     * so commits render with the App's name and avatar. Omitted in tests; falls
     * back to the stable default identity.
     */
    private readonly identity: GitIdentity = FIXOWL_DEFAULT_GIT_IDENTITY,
  ) {}

  /** This workspace's explicit `--git-dir` path (issue #36's lane factory needs it to fan out worktrees). */
  get gitDirPath(): string {
    return this.gitDir;
  }

  private async authEnv(): Promise<Record<string, string> | undefined> {
    if (this.tokenProvider === undefined) return undefined;
    const token = await this.tokenProvider();
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
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
      env: await this.authEnv(),
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
    await this.git("config", "user.name", this.identity.name);
    await this.git("config", "user.email", this.identity.email);
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

  /**
   * Read the tip commit of a remote branch (author email + subject) so the
   * orphan-branch reset can confirm the branch is fixowl's own work before
   * deleting it (issue #69). The branch is fetched first, so it resolves even
   * when it was pushed after the night's checkout.
   */
  async remoteBranchTip(branch: string): Promise<CommitTip> {
    await this.fetchRemoteBranch(branch);
    const out = (await this.git("log", "-1", "--format=%ae%n%s", `refs/remotes/origin/${branch}`))
      .stdout;
    const newline = out.indexOf("\n");
    const authorEmail = newline === -1 ? out : out.slice(0, newline);
    const subject = newline === -1 ? "" : out.slice(newline + 1);
    return { authorEmail: authorEmail.trim(), subject: subject.trim() };
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

  /**
   * Delete a remote issue branch. Used to reset an orphaned branch - one pushed
   * by a prior night that was interrupted before its PR opened - so the retry
   * pushes a fresh branch from the base rather than hitting a non-fast-forward
   * (issue #57). The caller must first confirm the branch is fixowl's own work
   * (`remoteBranchTip` + `isFixowlBranchTip`, issue #69) so a human's hand-pushed
   * `issue/<n>-*` branch is never deleted. Contents:write only; deleting a ref
   * is never a merge.
   */
  async deleteRemoteBranch(branch: string): Promise<void> {
    await this.git("push", "origin", "--delete", `refs/heads/${branch}`);
  }
}

// ---------------------------------------------------------------------------
// Bounded concurrency (issue #36): a lane is one `git worktree`-isolated
// checkout so an independent chain can run concurrently with others without
// the checkouts stepping on each other's HEAD/index. Only the OUTER chain
// loop uses lanes; each chain's own issues still run strictly sequentially in
// their assigned lane (main.ts).
// ---------------------------------------------------------------------------

/** Bytes a single agent/verify container is capped at (container-exec.ts `--memory 6g`). */
const BYTES_PER_CONTAINER = 6 * 1024 ** 3;

export interface LaneCountResult {
  /** The effective number of concurrent lanes to run tonight. Always >= 1. */
  laneCount: number;
  /** How many lanes the host's RAM can safely support (>= 1). */
  memoryGuard: number;
  /** True when the configured `max_parallel` was clamped down by the memory guard. */
  clampedByMemory: boolean;
}

/**
 * Pure resource-guard math, kept independent of `os.totalmem()` so it is unit
 * testable without mocking the OS module. Effective concurrency is the min of:
 * the configured `max_parallel`, a RAM-based guard (`floor(0.8 * totalMemBytes
 * / 6GB)`, since each container is capped at 6g), and tonight's chain count
 * (no point starting more lanes than there is independent work). Always
 * returns at least 1 lane.
 */
export function resolveLaneCount(params: {
  maxParallel: number;
  chainCount: number;
  totalMemBytes: number;
}): LaneCountResult {
  const { maxParallel, chainCount, totalMemBytes } = params;
  const memoryGuard = Math.max(1, Math.floor((0.8 * totalMemBytes) / BYTES_PER_CONTAINER));
  const byChains = Math.max(1, chainCount);
  const laneCount = Math.max(1, Math.min(maxParallel, memoryGuard, byChains));
  return {
    laneCount,
    memoryGuard,
    clampedByMemory: memoryGuard < maxParallel && laneCount === memoryGuard,
  };
}

/** Where lane `index`'s worktree lives, under the main workspace. */
export function laneWorkDir(mainWorkDir: string, index: number): string {
  return join(mainWorkDir, "worktrees", `lane-${index}`);
}

/** Where git keeps lane `index`'s worktree administrative files (its "git dir"). */
function laneAdminDir(mainGitDir: string, index: number): string {
  return join(mainGitDir, "worktrees", `lane-${index}`);
}

/**
 * Creates `laneCount` `git worktree` lanes off the current HEAD (detached, so
 * no branch-checked-out conflict with the main workspace or other lanes), each
 * wrapped in its own `GitWorkspace` sharing the extracted main git dir. Every
 * lane git command still names its own explicit `--git-dir` (the worktree's
 * administrative dir under `<mainGitDir>/worktrees/lane-<i>`), so the "git dir
 * never enters a container" invariant holds per lane exactly as it does for
 * the main workspace - the worktree's `.git` file left in the lane's working
 * tree is inert to these commands and is dropped by `dropPlantedGitDir` before
 * the first container run, same as a planted `.git` on the main workspace.
 */
export async function createLaneWorkspaces(params: {
  exec: Exec;
  mainGitDir: string;
  mainWorkDir: string;
  laneCount: number;
  tokenProvider?: () => Promise<string> | string;
  identity?: GitIdentity;
}): Promise<GitWorkspace[]> {
  const { exec, mainGitDir, mainWorkDir, laneCount, tokenProvider, identity } = params;
  const lanes: GitWorkspace[] = [];
  for (let i = 0; i < laneCount; i++) {
    const dir = laneWorkDir(mainWorkDir, i);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    const result = await exec.run(
      ["git", "--git-dir", mainGitDir, "worktree", "add", "--detach", dir, "HEAD"],
      { cwd: mainWorkDir },
    );
    if (result.code !== 0) {
      throw new Error(
        `git worktree add (lane ${i}) failed (exit ${result.code}): ${result.stderr}`,
      );
    }
    // `identity` undefined still resolves to the class's own default parameter
    // (FIXOWL_DEFAULT_GIT_IDENTITY), exactly like constructing the main GitWorkspace.
    lanes.push(new GitWorkspace(exec, dir, laneAdminDir(mainGitDir, i), tokenProvider, identity));
  }
  return lanes;
}

/**
 * Tears down every lane created by `createLaneWorkspaces`. Deletes each lane's
 * working directory first, then `git worktree prune` (NOT `git worktree
 * remove`, which refuses a worktree whose `.git` file was stripped by
 * `dropPlantedGitDir`/container hardening - prune only cleans up the
 * now-dangling administrative metadata, which is safe once the working
 * directory itself is already gone). Best-effort per lane so one stuck lane
 * never strands the rest.
 */
export async function teardownLanes(params: {
  exec: Exec;
  mainGitDir: string;
  mainWorkDir: string;
  laneCount: number;
}): Promise<void> {
  const { exec, mainGitDir, mainWorkDir, laneCount } = params;
  for (let i = 0; i < laneCount; i++) {
    rmSync(laneWorkDir(mainWorkDir, i), { recursive: true, force: true });
  }
  await exec.run(["git", "--git-dir", mainGitDir, "worktree", "prune"], { cwd: mainWorkDir });
  // Best-effort: drop the now-empty `worktrees` parent dir too, so a clean
  // night leaves nothing behind for the next run's own lanes to collide with
  // (the workflow's "Reset workspace git state" step is the crash-safety net).
  rmSync(dirname(laneWorkDir(mainWorkDir, 0)), { recursive: true, force: true });
}
