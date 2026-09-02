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
    detail:
      "no working docker engine; install colima (brew install colima docker) and run `colima start`",
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
