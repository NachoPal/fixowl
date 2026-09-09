import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalConfigSchema } from "@fixowl/core";
import type { CliContext } from "../context.ts";
import { manualProvisionCommand } from "./provision-manual.ts";

function makeCtx(): CliContext {
  return {
    config: globalConfigSchema.parse({
      version: 1,
      github: {
        admin_token: "ghp_admin",
        app: { app_id: 123456, installation_id: 7890123, private_key: "${FIXOWL_APP_PRIVATE_KEY}" },
      },
      repos: [{ name: "acme/widgets" }],
    }),
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
    // Never read: manual provisioning must not call the GitHub API for the
    // target repo at all, so a poisoned admin client proves it.
    admin: new Proxy(
      {},
      {
        get(): never {
          throw new Error("manual provisioning must never touch ctx.admin");
        },
      },
    ) as CliContext["admin"],
  } as unknown as CliContext;
}

describe("fixowl provision --manual", () => {
  let outDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("never calls the GitHub API for the target repo and emits the rendered artifacts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    outDir = mkdtempSync(join(tmpdir(), "fixowl-manual-test-"));
    const resolveActionRef = vi.fn(async () => ({
      ref: "NachoPal/fixowl@deadbeef",
      comment: "main @ 2026-09-09",
    }));

    await manualProvisionCommand(makeCtx(), undefined, { outDir, resolveActionRef });

    expect(resolveActionRef).toHaveBeenCalledTimes(1);
    const workflow = readFileSync(join(outDir, ".github/workflows/fixowl.yml"), "utf8");
    expect(workflow).toContain("NachoPal/fixowl@deadbeef");
    expect(readFileSync(join(outDir, ".fixowl.yml"), "utf8")).not.toBe("");
    expect(
      readFileSync(join(outDir, ".github/ISSUE_TEMPLATE/fixowl-overnight.yml"), "utf8"),
    ).not.toBe("");
  });

  it("prints the label, secret, and file steps without leaking any secret value", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });
    outDir = mkdtempSync(join(tmpdir(), "fixowl-manual-test-"));
    const resolveActionRef = vi.fn(async () => ({
      ref: "NachoPal/fixowl@deadbeef",
      comment: "main @ 2026-09-09",
    }));

    await manualProvisionCommand(makeCtx(), undefined, { outDir, resolveActionRef });

    const output = logs.join("\n");
    expect(output).toContain("gh label create");
    expect(output).toContain("gh secret set FIXOWL_APP_ID");
    expect(output).toContain("gh secret set FIXOWL_APP_INSTALLATION_ID");
    expect(output).toContain("gh secret set FIXOWL_APP_PRIVATE_KEY");
    expect(output).toContain("gh secret set CLAUDE_CODE_OAUTH_TOKEN");
    // Never print the sensitive value itself, only the secret's name.
    expect(output).not.toContain("oauth-token");
  });

  it("refuses to provision the test-only script agent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    outDir = mkdtempSync(join(tmpdir(), "fixowl-manual-test-"));
    const ctx = makeCtx();
    ctx.config.repos[0]!.agent = "script";

    await expect(
      manualProvisionCommand(ctx, undefined, {
        outDir,
        resolveActionRef: async () => ({ ref: "x@y", comment: "z" }),
      }),
    ).rejects.toThrow(/script/);
  });
});
