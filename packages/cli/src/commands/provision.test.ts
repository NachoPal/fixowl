import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { globalConfigSchema } from "@fixowl/core";
import type { CliContext } from "../context.ts";
import { provisionCommand } from "./provision.ts";

/**
 * A fake Octokit that lets provision's repo-setup steps run to completion so the
 * test can observe the registration step at the end. Labels and files are
 * reported as already present, so the branch/PR paths stay quiet.
 */
function fakeOctokit(): Octokit {
  const filePresent = {
    data: { type: "file", content: Buffer.from("old").toString("base64"), sha: "filesha" },
  };
  return {
    rest: {
      repos: {
        getCommit: vi.fn(async () => ({ data: { sha: "actionsha" } })),
        get: vi.fn(async () => ({ data: { default_branch: "main", private: true } })),
        getContent: vi.fn(async () => filePresent),
        createOrUpdateFileContents: vi.fn(async () => ({})),
      },
      issues: {
        getLabel: vi.fn(async () => ({ data: {} })),
      },
      actions: {
        // 32-byte key so the libsodium sealed box in putRepoSecret succeeds.
        getRepoPublicKey: vi.fn(async () => ({
          data: { key: Buffer.alloc(32, 1).toString("base64"), key_id: "kid" },
        })),
        createOrUpdateRepoSecret: vi.fn(async () => ({})),
      },
    },
  } as unknown as Octokit;
}

function makeCtx(): CliContext {
  return {
    config: globalConfigSchema.parse({
      version: 1,
      github: { admin_token: "ghp_admin", runtime_token: "ghp_runtime" },
      repos: [{ name: "acme/widgets" }],
    }),
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
    admin: fakeOctokit(),
  } as unknown as CliContext;
}

describe("fixowl provision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the runner on this host as part of provisioning", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerRunner = vi.fn(async () => "configured" as const);

    await provisionCommand(makeCtx(), undefined, { registerRunner });

    expect(registerRunner).toHaveBeenCalledTimes(1);
    expect(registerRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: "acme/widgets",
        ref: { owner: "acme", repo: "widgets" },
      }),
    );
  });

  it("skips registration with --no-register (for provisioning off the runner host)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerRunner = vi.fn(async () => "configured" as const);

    await provisionCommand(makeCtx(), undefined, { noRegister: true, registerRunner });

    expect(registerRunner).not.toHaveBeenCalled();
  });
});
