import { spawn } from "node:child_process";
import type { Exec, ExecOptions, ExecResult } from "./deps.ts";

/** Spawns argv directly (no shell). Extra env is merged over the parent process env. */
export const realExec: Exec = {
  run(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const [command, ...args] = argv;
      if (command === undefined) {
        reject(new Error("empty argv"));
        return;
      }
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr, timedOut: false }));
      if (options?.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    });
  },
};
