import type { Exec, ExecResult } from "./deps.ts";

/**
 * All git happens on the host (the runner), outside any container: the coding
 * agent never sees a GitHub token.
 *
 * Credential handling is deliberately paranoid: the workspace (including
 * `.git/`) is bind-mounted into untrusted agent and verification containers,
 * so the runtime PAT must never be written into the repo (no remote URLs with
 * tokens, no credential helpers). Instead it is injected per git command as an
 * env-based `http.extraheader`, which keeps it out of argv (`ps`), out of git
 * error messages, and out of every file under the workspace.
 */
export class GitWorkspace {
  constructor(
    private readonly exec: Exec,
    private readonly dir: string,
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

  private async git(...argv: string[]): Promise<ExecResult> {
    const result = await this.exec.run(["git", ...argv], { cwd: this.dir, env: this.authEnv() });
    if (result.code !== 0) {
      throw new Error(
        `git ${argv[0]} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result;
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
    await this.git("checkout", "-B", branch, baseRef);
  }

  async checkout(ref: string): Promise<void> {
    await this.git("checkout", ref);
  }

  async discardAllChanges(): Promise<void> {
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
   * One commit `fix #<n>: <title>` in the normal case. If the agent committed
   * on its own despite instructions, its commits are kept as-is (nothing left
   * to stage), so the subject line is then the agent's; the PR body's
   * `Closes #<n>` still links the issue.
   */
  async commitAll(message: string): Promise<void> {
    await this.git("add", "-A");
    const staged = await this.exec.run(["git", "diff", "--cached", "--quiet"], { cwd: this.dir });
    if (staged.code !== 0) {
      await this.git("commit", "-m", message);
    }
  }

  async push(branch: string): Promise<void> {
    await this.git("push", "origin", `${branch}:refs/heads/${branch}`);
  }
}
