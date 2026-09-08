import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentAdapter } from "@fixowl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSecretsEnv } from "../config-load.ts";
import type { EngineStatus } from "../docker/engine-check.ts";
import { renderConfigYaml } from "../init/config-file.ts";
import { AGENT_CHOICES, AGENT_SECRET_HELP, initCommand } from "./init.ts";

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

    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("admin_token: ${FIXOWL_ADMIN_TOKEN}");
    expect(config).toContain("private_key: ${FIXOWL_APP_PRIVATE_KEY}");
    expect(config).not.toContain("runtime_token");
    expect(parseSecretsEnv(readFileSync(secretsPath, "utf8"))).toEqual({
      FIXOWL_ADMIN_TOKEN: "",
      FIXOWL_APP_PRIVATE_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
  });

  it("points App setup at the one-click manifest flow, with manual creation as a footnote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
    const configPath = join(dir, "config.yaml");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });
    vi.restoreAllMocks();

    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("one browser click");
    expect(printed).toContain("App Manifest");
    expect(printed).toContain("Manual App setup (advanced)");
    // The old co-equal step-by-step creation guide is gone (Tier-1 lesson:
    // one onboarding path, with manual creation only an advanced footnote).
    expect(printed).not.toContain("https://github.com/settings/apps/new");
    expect(printed).not.toContain('UNCHECK "Active"');
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

describe("fixowl init agent picker (step 2/4)", () => {
  it("carries an env allowlist the core adapter accepts for every choice", () => {
    for (const choice of AGENT_CHOICES) {
      // getAgentAdapter throws on an unknown agent or a forbidden env var, so a
      // clean call proves the wizard's choice is a real, safe adapter override.
      const adapter = getAgentAdapter(choice.value, choice.env);
      expect(adapter.env).toEqual([...choice.env]);
    }
  });

  it("flows each picker choice into a correct agents block in the written config", () => {
    for (const choice of AGENT_CHOICES) {
      // Mirror stepAgent: the choice's env is opted into the adapter allowlist,
      // then rendered into config.yaml. Assert on the emitted, parsed config.
      const agentEnv = getAgentAdapter(choice.value, choice.env).env;
      const yaml = renderConfigYaml({
        agent: choice.value,
        agentEnv,
        repos: [
          { name: "owner/repo", schedule: "37 1 * * *", labels: ["fix"], maxIssuesPerRun: 3 },
        ],
        app: { appId: "123", installationId: "456" },
      });

      const agentsBlock = yaml.slice(yaml.indexOf("\nagents:\n"));
      expect(agentsBlock).toContain(`${choice.value}: { env: [${agentEnv.join(", ")}] }`);
    }
  });

  it("provides real credential guidance for every agent's env var", () => {
    for (const choice of AGENT_CHOICES) {
      for (const name of choice.env) {
        expect(AGENT_SECRET_HELP[name], `missing help for ${name}`).toBeTruthy();
      }
    }
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
