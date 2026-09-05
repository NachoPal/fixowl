import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { globalConfigSchema } from "@fixowl/core";
import type { CliContext } from "../context.ts";
import { provisionCommand, type ProvisionOptions } from "./provision.ts";

interface FileWrite {
  path: string;
  branch: string;
}

interface PrCreate {
  head: string;
  base: string;
  title: string;
  body: string;
}

interface FakeOctokit {
  octokit: Octokit;
  fileWrites: FileWrite[];
  prsCreated: PrCreate[];
}

/**
 * A fake Octokit that lets provision's repo-setup steps run to completion and
 * records how each file was written (which branch) and any PR opened, so tests
 * can assert whether the workflow went through the PR branch or straight to the
 * default branch. Existing files return "old" content (so the workflow, whose
 * rendered content differs, is an update rather than a no-op); the provision
 * branch is reported as not existing so createBranch runs.
 */
function fakeOctokit(): FakeOctokit {
  const fileWrites: FileWrite[] = [];
  const prsCreated: PrCreate[] = [];
  const filePresent = {
    data: { type: "file", content: Buffer.from("old").toString("base64"), sha: "filesha" },
  };
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const octokit = {
    rest: {
      repos: {
        getCommit: vi.fn(async () => ({ data: { sha: "actionsha" } })),
        get: vi.fn(async () => ({ data: { default_branch: "main", private: true } })),
        getContent: vi.fn(async () => filePresent),
        getBranch: vi.fn(async () => {
          throw notFound;
        }),
        createOrUpdateFileContents: vi.fn(async (params: { path: string; branch: string }) => {
          fileWrites.push({ path: params.path, branch: params.branch });
          return {};
        }),
      },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: "basesha" } } })),
        createRef: vi.fn(async () => ({})),
      },
      pulls: {
        list: vi.fn(async () => ({ data: [] })),
        create: vi.fn(async (params: PrCreate) => {
          prsCreated.push(params);
          return { data: { html_url: `https://github.com/pr/${prsCreated.length}` } };
        }),
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
  return { octokit, fileWrites, prsCreated };
}

function makeCtx(admin: Octokit): CliContext {
  return {
    config: globalConfigSchema.parse({
      version: 1,
      github: { admin_token: "ghp_admin", runtime_token: "ghp_runtime" },
      repos: [{ name: "acme/widgets" }],
    }),
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
    admin,
  } as unknown as CliContext;
}

const WORKFLOW_PATH = ".github/workflows/fixowl.yml";

async function runProvision(options: ProvisionOptions): Promise<FakeOctokit> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fake = fakeOctokit();
  await provisionCommand(makeCtx(fake.octokit), undefined, {
    registerRunner: vi.fn(async () => "configured" as const),
    ...options,
  });
  return fake;
}

describe("fixowl provision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proposes the workflow via the provision PR branch by default", async () => {
    const { fileWrites, prsCreated } = await runProvision({});

    const workflowWrite = fileWrites.find((w) => w.path === WORKFLOW_PATH);
    expect(workflowWrite?.branch).toBe("fixowl/provision-workflow");
    expect(fileWrites).not.toContainEqual({ path: WORKFLOW_PATH, branch: "main" });
    expect(prsCreated).toContainEqual(
      expect.objectContaining({ head: "fixowl/provision-workflow", base: "main" }),
    );
  });

  it("pushes the workflow straight to the default branch with the --no-pr opt-out", async () => {
    const { fileWrites, prsCreated } = await runProvision({ pr: false });

    expect(fileWrites).toContainEqual({ path: WORKFLOW_PATH, branch: "main" });
    expect(fileWrites.some((w) => w.branch === "fixowl/provision-workflow")).toBe(false);
    expect(prsCreated.some((p) => p.head === "fixowl/provision-workflow")).toBe(false);
  });

  it("keeps the workflow on the PR branch when --pr is passed (back-compat no-op)", async () => {
    const { fileWrites, prsCreated } = await runProvision({ pr: true });

    const workflowWrite = fileWrites.find((w) => w.path === WORKFLOW_PATH);
    expect(workflowWrite?.branch).toBe("fixowl/provision-workflow");
    expect(prsCreated).toContainEqual(
      expect.objectContaining({ head: "fixowl/provision-workflow", base: "main" }),
    );
  });

  it("the workflow PR body no longer tells operators to pass --pr", async () => {
    const { prsCreated } = await runProvision({});

    const workflowPr = prsCreated.find((p) => p.head === "fixowl/provision-workflow");
    expect(workflowPr?.body).not.toContain("--pr");
    expect(workflowPr?.body).toContain("Merge this PR to activate scheduled runs");
  });

  it("registers the runner on this host as part of provisioning", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerRunner = vi.fn(async () => "configured" as const);

    await provisionCommand(makeCtx(fakeOctokit().octokit), undefined, { registerRunner });

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

    await provisionCommand(makeCtx(fakeOctokit().octokit), undefined, {
      noRegister: true,
      registerRunner,
    });

    expect(registerRunner).not.toHaveBeenCalled();
  });
});
