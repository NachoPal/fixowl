import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseSecretsEnv, substituteSecretRefs } from "./config-load.ts";

describe("parseSecretsEnv", () => {
  it("parses KEY=VALUE with comments, blanks, and quotes", () => {
    const parsed = parseSecretsEnv(
      `# tokens\nFIXOWL_ADMIN_TOKEN=github_pat_abc\n\nQUOTED="with = sign"\nSINGLE='x'\n`,
    );
    expect(parsed).toEqual({
      FIXOWL_ADMIN_TOKEN: "github_pat_abc",
      QUOTED: "with = sign",
      SINGLE: "x",
    });
  });

  it("rejects malformed lines", () => {
    expect(() => parseSecretsEnv("NOT A LINE")).toThrow(/line 1/);
  });
});

describe("substituteSecretRefs", () => {
  it("substitutes nested ${VAR} references", () => {
    const result = substituteSecretRefs(
      { github: { admin_token: "${A}" }, list: ["${B}", "plain"] },
      { A: "va", B: "vb" },
    );
    expect(result).toEqual({ github: { admin_token: "va" }, list: ["vb", "plain"] });
  });

  it("throws on missing references", () => {
    expect(() => substituteSecretRefs("${MISSING}", {})).toThrow(/\$\{MISSING\}/);
  });

  it("leaves non-reference strings alone", () => {
    expect(substituteSecretRefs("37 1 * * *", {})).toBe("37 1 * * *");
  });
});

describe("loadConfig", () => {
  it("loads config with secrets resolved and warns about loose permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-config-"));
    const configPath = join(dir, "config.yaml");
    const secretsPath = join(dir, "secrets.env");
    writeFileSync(
      configPath,
      [
        "version: 1",
        "github:",
        "  admin_token: ${FIXOWL_ADMIN_TOKEN}",
        "  runtime_token: ${FIXOWL_RUNTIME_TOKEN}",
        "repos:",
        "  - name: NachoPal/storyengine",
      ].join("\n"),
    );
    writeFileSync(secretsPath, "FIXOWL_ADMIN_TOKEN=aaa\nFIXOWL_RUNTIME_TOKEN=rrr\n", {
      mode: 0o644,
    });
    const { config, warnings } = loadConfig(configPath, secretsPath);
    expect(config.github.admin_token).toBe("aaa");
    expect(config.github.runtime_token).toBe("rrr");
    expect(warnings.some((w) => w.includes("chmod 600"))).toBe(true);
  });

  it("errors when the config is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-config-"));
    expect(() => loadConfig(join(dir, "nope.yaml"), join(dir, "nope.env"))).toThrow(/fixowl init/);
  });
});
