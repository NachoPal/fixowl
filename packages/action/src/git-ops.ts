import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type CommitTip, FIXOWL_DEFAULT_GIT_IDENTITY, type GitIdentity } from "@fixowl/core";
import type { Exec, ExecResult } from "./deps.ts";

/**
 * The outcome of a rebase step (`rebaseOnto` / `rebaseContinue`):
 *  - `clean`      the rebase applied/completed with no conflicts.
 *  - `conflicted` it stopped with unmerged paths; `files` are the conflicted
 *                 working-tree files for the agent to resolve.
 *  - `stuck`      `rebase --continue` could not proceed (nothing staged to
 *                 resolve) - only from `rebaseContinue`.
 */
export type RebaseResult =
  | { status: "clean" }
  | { status: "conflicted"; files: string[] }
  | { status: "stuck" };

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
   * Runs a git command WITHOUT throwing on a non-zero exit, so callers can
   * branch on the code (a rebase "fails" with conflicts, which is expected).
   * `extraEnv` is merged over the auth env (e.g. GIT_EDITOR for a non-interactive
   * `rebase --continue`).
   */
  private async gitRaw(
    extraEnv: Record<string, string> | undefined,
    ...argv: string[]
  ): Promise<ExecResult> {
    const auth = await this.authEnv();
    const env = auth !== undefined || extraEnv !== undefined ? { ...auth, ...extraEnv } : undefined;
    return this.exec.run([...this.baseArgv(), ...argv], { cwd: this.dir, env });
  }

  /** The unmerged (conflicted) working-tree paths of an in-progress rebase. */
  private async unmergedFiles(): Promise<string[]> {
    const out = await this.gitRaw(undefined, "diff", "--name-only", "--diff-filter=U");
    return out.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  /**
   * Rebase the current branch onto the CURRENT tip of `baseBranch` (fetched
   * first, since the night otherwise keeps the base ref it fetched at job start).
   * A clean rebase leaves the branch replayed onto the new base; a conflict stops
   * the rebase with markers in the working tree for the agent to resolve
   * (`rebaseContinue` after). A non-conflict failure aborts and throws so the
   * caller annotates rather than silently proceeding. Used to recover a PR that
   * went `dirty` because its base advanced (conflict-gate.ts).
   */
  async rebaseOnto(
    baseBranch: string,
  ): Promise<{ status: "clean" } | { status: "conflicted"; files: string[] }> {
    await this.fetchRemoteBranch(baseBranch);
    const result = await this.gitRaw(undefined, "rebase", `refs/remotes/origin/${baseBranch}`);
    if (result.code === 0) return { status: "clean" };
    const files = await this.unmergedFiles();
    if (files.length > 0) return { status: "conflicted", files };
    await this.rebaseAbort();
    throw new Error(
      `git rebase onto origin/${baseBranch} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  /**
   * Stage the agent's conflict resolution and continue the rebase. Returns
   * `clean` when the rebase finished, `conflicted` when it stopped again on a
   * later commit (the branch may carry more than one commit), or `stuck` when it
   * could not proceed. `GIT_EDITOR=true` keeps `rebase --continue` from opening
   * an editor for the reused commit message (an unattended run must never hang).
   */
  async rebaseContinue(): Promise<RebaseResult> {
    await this.git("add", "-A");
    const result = await this.gitRaw({ GIT_EDITOR: "true" }, "rebase", "--continue");
    if (result.code === 0) return { status: "clean" };
    const files = await this.unmergedFiles();
    if (files.length > 0) return { status: "conflicted", files };
    return { status: "stuck" };
  }

  /** Abort an in-progress rebase, best-effort (never throws from teardown). */
  async rebaseAbort(): Promise<void> {
    await this.gitRaw(undefined, "rebase", "--abort");
  }

  /**
   * Force-push a rewritten branch with `--force-with-lease`: git refuses if the
   * remote branch advanced beyond what we last pushed, so a concurrent push is
   * never clobbered - the branch-ownership guard for a rewritten history. Used
   * after a rebase; the branch is still exactly one PR (the idempotency marker).
   */
  async forcePushWithLease(branch: string): Promise<void> {
    await this.git("push", "--force-with-lease", "origin", `${branch}:refs/heads/${branch}`);
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
