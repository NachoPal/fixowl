import { spawn } from "node:child_process";

export interface CliExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CliExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Stream child output to the terminal as it happens. */
  inherit?: boolean;
}

/** Spawns argv directly (no shell). */
export function run(argv: readonly string[], options?: CliExecOptions): Promise<CliExecResult> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("empty argv"));
      return;
    }
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: options?.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runOrThrow(
  argv: readonly string[],
  options?: CliExecOptions,
): Promise<CliExecResult> {
  const result = await run(argv, options);
  if (result.code !== 0) {
    throw new Error(
      `${argv.join(" ")} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}
