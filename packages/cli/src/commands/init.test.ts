import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSecretsEnv } from "../config-load.ts";
import { initCommand } from "./init.ts";

describe("fixowl init --non-interactive", () => {
  it("scaffolds a config and a mode-600 secrets file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
    const configPath = join(dir, "config.yaml");
    const secretsPath = join(dir, "secrets.env");

    await initCommand({ configPath, nonInteractive: true });

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

    await initCommand({ configPath, nonInteractive: true });
    const before = readFileSync(configPath, "utf8");
    await initCommand({ configPath, nonInteractive: true });

    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});
