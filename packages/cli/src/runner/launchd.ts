import { run, runOrThrow } from "../exec.ts";

/**
 * The runner tarball bundles `svc.sh`, which manages the platform service
 * (launchd on macOS, systemd on Linux) including reboot survival. We drive it
 * rather than writing plists ourselves.
 */

export type ServiceState = "running" | "stopped" | "not-installed";

export async function svcStatus(dir: string): Promise<ServiceState> {
  const result = await run(["./svc.sh", "status"], { cwd: dir });
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("not installed")) return "not-installed";
  // launchd prints "Started:\n<pid> 0 <label>" when running; "Stopped" otherwise
  if (output.includes("started") && !output.includes("not started")) return "running";
  return "stopped";
}

export async function svcInstall(dir: string): Promise<void> {
  if ((await svcStatus(dir)) !== "not-installed") return;
  await runOrThrow(["./svc.sh", "install"], { cwd: dir });
}

export async function svcStart(dir: string): Promise<void> {
  if ((await svcStatus(dir)) === "running") return;
  await runOrThrow(["./svc.sh", "start"], { cwd: dir });
}

export async function svcStop(dir: string): Promise<void> {
  if ((await svcStatus(dir)) !== "running") return;
  await runOrThrow(["./svc.sh", "stop"], { cwd: dir });
}

export async function svcUninstall(dir: string): Promise<void> {
  if ((await svcStatus(dir)) === "not-installed") return;
  await svcStop(dir);
  await runOrThrow(["./svc.sh", "uninstall"], { cwd: dir });
}
