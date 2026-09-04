import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSecretsEnv } from "../config-load.ts";
import type { EngineStatus } from "../docker/engine-check.ts";
import { initCommand } from "./init.ts";

const stubEngine = async (): Promise<EngineStatus> => ({
  ok: true,
  engine: "docker",
  detail: "docker engine (test stub)",
});

describe("fixowl init --non-interactive", () => {
  it("scaffolds a config and a mode-600 secrets file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
    const configPath = join(dir, "config.yaml");
    const secretsPath = join(dir, "secrets.env");

    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });

    expect(readFileSync(configPath, "utf8")).toContain("admin_token: ${FIXOWL_ADMIN_TOKEN}");
    expect(parseSecretsEnv(readFileSync(secretsPath, "utf8"))).toEqual({
      FIXOWL_ADMIN_TOKEN: "",
      FIXOWL_RUNTIME_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
  });

  it("leaves existing files alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
    const configPath = join(dir, "config.yaml");

    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });
    const before = readFileSync(configPath, "utf8");
    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });

    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});

function scaffoldArgs(): { configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
  return { configPath: join(dir, "config.yaml") };
}

describe("fixowl init container-engine report", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirms the engine when one is present, without failing", async () => {
    const okSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const present: EngineStatus = { ok: true, engine: "colima", detail: "colima running" };

    await initCommand({
      ...scaffoldArgs(),
      nonInteractive: true,
      checkEngine: async () => present,
    });

    expect(okSpy.mock.calls.flat().join("\n")).toContain("container engine ready");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns non-fatally when no engine is present, pointing at validate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const absent: EngineStatus = {
      ok: false,
      engine: "none",
      detail: "no working docker engine; install Docker and start the daemon",
    };

    // Init must still succeed (write config) rather than throw when no engine.
    await expect(
      initCommand({ ...scaffoldArgs(), nonInteractive: true, checkEngine: async () => absent }),
    ).resolves.toBeUndefined();

    const warned = warnSpy.mock.calls.flat().join("\n");
    expect(warned).toContain("no working docker engine");
    expect(warned).toContain("fixowl start");
    expect(warned).toContain("fixowl validate");
  });
});
