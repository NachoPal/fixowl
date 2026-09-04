import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../exec.ts";

export interface EngineStatus {
  ok: boolean;
  engine: "colima" | "docker" | "none";
  /** Set when jobs need DOCKER_HOST to reach the engine (Colima). */
  dockerHost?: string;
  detail: string;
}

export function colimaSocketPath(): string {
  return join(homedir(), ".colima", "default", "docker.sock");
}

/**
 * OS-aware guidance for installing a Docker-compatible engine, derived from
 * `process.platform`. macOS gets Colima (fixowl's preferred engine) or Docker
 * Desktop; Linux gets native Docker; anything else gets a generic hint.
 */
export function engineInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return (
        "install a container engine - Colima (`brew install colima docker`, then " +
        "`colima start`) or Docker Desktop"
      );
    case "linux":
      return "install Docker (your distro's package or docker.com) and start the daemon";
    default:
      return "install and start a Docker-compatible container engine";
  }
}

export async function checkDockerEngine(): Promise<EngineStatus> {
  const colima = await run(["colima", "status"]).catch(() => undefined);
  if (colima?.code === 0) {
    const socket = colimaSocketPath();
    return {
      ok: true,
      engine: "colima",
      dockerHost: `unix://${socket}`,
      detail: existsSync(socket)
        ? `colima running (socket ${socket})`
        : `colima reports running but ${socket} is missing`,
    };
  }
  const docker = await run(["docker", "info", "--format", "{{.ServerVersion}}"]).catch(
    () => undefined,
  );
  if (docker?.code === 0) {
    return {
      ok: true,
      engine: "docker",
      detail: `docker engine ${docker.stdout.trim()} (not colima; fine for dev machines)`,
    };
  }
  return {
    ok: false,
    engine: "none",
    detail: `no working docker engine; ${engineInstallHint()}`,
  };
}

/** Starts Colima when it is installed but not running; leaves other engines alone. */
export async function ensureEngineRunning(): Promise<EngineStatus> {
  const status = await checkDockerEngine();
  if (status.ok) return status;
  const hasColima = (await run(["colima", "version"]).catch(() => undefined))?.code === 0;
  if (hasColima) {
    const started = await run(["colima", "start"], { inherit: true });
    if (started.code === 0) return await checkDockerEngine();
  }
  return status;
}
