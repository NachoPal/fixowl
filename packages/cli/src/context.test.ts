import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN_MISSING_MESSAGE, makeContext, requireAdmin } from "./context.ts";

/**
 * A minimal-but-valid config.yaml body. `admin_token` is deliberately omitted:
 * the setup-only admin PAT is optional at load, so routine commands must load a
 * config without it (issue #80). Callers append `admin_token:` when they want it.
 */
function configYaml(withAdminToken: boolean): string {
  return [
    "version: 1",
    "github:",
    ...(withAdminToken ? ["  admin_token: ${FIXOWL_ADMIN_TOKEN}"] : []),
    "  app:",
    "    app_id: 123456",
    "    installation_id: 7890123",
    "    private_key: ${FIXOWL_APP_PRIVATE_KEY}",
    "repos:",
    "  - name: acme/widgets",
    "",
  ].join("\n");
}

/** Writes a config.yaml + secrets.env pair in a throwaway dir and returns the config path. */
function writeConfig(withAdminToken: boolean): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "fixowl-ctx-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, configYaml(withAdminToken));
  const secrets = [
    "FIXOWL_APP_PRIVATE_KEY=pem-placeholder",
    ...(withAdminToken ? ["FIXOWL_ADMIN_TOKEN=ghp_admin"] : []),
    "",
  ].join("\n");
  writeFileSync(join(dir, "secrets.env"), secrets);
  return { dir, configPath };
}

describe("makeContext", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads a config with no admin_token (setup-only token revoked, per docs/security.md)", () => {
    const { dir, configPath } = writeConfig(false);
    dirs.push(dir);

    const ctx = makeContext(configPath);

    // The config loads; admin_token is simply absent, not a validation error.
    expect(ctx.config.github.admin_token).toBeUndefined();
    expect(ctx.config.repos[0]?.name).toBe("acme/widgets");
  });

  it("throws a clear, actionable error only when the admin client is actually reached", () => {
    const { dir, configPath } = writeConfig(false);
    dirs.push(dir);

    const ctx = makeContext(configPath);

    // Building the context did NOT touch the admin token (routine commands work).
    // Reaching for the admin client is what surfaces the setup-only guidance.
    expect(() => ctx.admin).toThrow(ADMIN_TOKEN_MISSING_MESSAGE);
    expect(() => requireAdmin(ctx)).toThrow(/setup-only/);
  });

  it("builds the admin client lazily and memoizes it when admin_token is present", () => {
    const { dir, configPath } = writeConfig(true);
    dirs.push(dir);

    const ctx = makeContext(configPath);

    const first = ctx.admin;
    const second = ctx.admin;
    expect(first).toBeDefined();
    // Memoized: the same Octokit instance is reused across accesses.
    expect(first).toBe(second);
  });
});
