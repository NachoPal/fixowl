import type { ResolvedRepoSettings } from "@fixowl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context.ts";

// Fake the Octokit factory so no network is touched; the app-key helpers pass
// through so any private_key string is accepted in the test config.
const mocks = vi.hoisted(() => ({
  getAuthenticatedApp: vi.fn(),
  getInstallation: vi.fn(),
  listReposPaginate: vi.fn(),
}));

vi.mock("../github/client.ts", () => ({
  appClient: () => ({
    rest: {
      apps: {
        getAuthenticated: mocks.getAuthenticatedApp,
        getInstallation: mocks.getInstallation,
        listReposAccessibleToInstallation: "listReposEndpoint",
      },
    },
    paginate: mocks.listReposPaginate,
  }),
}));

vi.mock("../github/app-key.ts", () => ({
  resolvePrivateKey: (value: string) => value,
  toPkcs8Pem: (value: string) => value,
}));

const { validateRuntimeCredential, validateModelsAgainstLiveList } = await import("./validate.ts");

function ctxWith(github: Record<string, unknown>): CliContext {
  return { config: { github, repos: [{ name: "o/r" }] } } as unknown as CliContext;
}

async function collect(ctx: CliContext): Promise<string[]> {
  const errors: string[] = [];
  await validateRuntimeCredential(ctx, (message) => errors.push(message));
  return errors;
}

const APP_GITHUB = {
  admin_token: "ghp_admin",
  app: { app_id: 123456, installation_id: 7890123, private_key: "pem" },
};

const FULL_PERMS = { checks: "read", contents: "write", pull_requests: "write" };

describe("validateRuntimeCredential", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirms the App identity, Checks: read, and repo access", async () => {
    mocks.getAuthenticatedApp.mockResolvedValue({ data: { slug: "fixowl", id: 123456 } });
    mocks.getInstallation.mockResolvedValue({ data: { permissions: FULL_PERMS } });
    mocks.listReposPaginate.mockResolvedValue([{ full_name: "o/r" }]);

    const errors = await collect(ctxWith(APP_GITHUB));

    expect(errors).toEqual([]);
    expect(mocks.getAuthenticatedApp).toHaveBeenCalledTimes(1);
    expect(mocks.getInstallation).toHaveBeenCalledWith({ installation_id: 7890123 });
  });

  it("fails when the App is missing Checks: read (the CI gate would degrade)", async () => {
    mocks.getAuthenticatedApp.mockResolvedValue({ data: { slug: "fixowl", id: 123456 } });
    mocks.getInstallation.mockResolvedValue({
      data: { permissions: { contents: "write", pull_requests: "write" } },
    });
    mocks.listReposPaginate.mockResolvedValue([{ full_name: "o/r" }]);

    const errors = await collect(ctxWith(APP_GITHUB));

    expect(errors.some((error) => /Checks: read/.test(error))).toBe(true);
  });

  it("fails when the App is missing Contents: write (pushes would fail at night)", async () => {
    mocks.getAuthenticatedApp.mockResolvedValue({ data: { slug: "fixowl", id: 123456 } });
    mocks.getInstallation.mockResolvedValue({
      data: { permissions: { checks: "read", pull_requests: "write" } },
    });
    mocks.listReposPaginate.mockResolvedValue([{ full_name: "o/r" }]);

    const errors = await collect(ctxWith(APP_GITHUB));

    expect(errors.some((error) => /Contents: write/.test(error))).toBe(true);
  });

  it("fails when the App is missing Pull requests: write (opening PRs would fail)", async () => {
    mocks.getAuthenticatedApp.mockResolvedValue({ data: { slug: "fixowl", id: 123456 } });
    mocks.getInstallation.mockResolvedValue({
      data: { permissions: { checks: "read", contents: "write" } },
    });
    mocks.listReposPaginate.mockResolvedValue([{ full_name: "o/r" }]);

    const errors = await collect(ctxWith(APP_GITHUB));

    expect(errors.some((error) => /Pull requests: write/.test(error))).toBe(true);
  });

  it("fails when the App is not installed on a configured repo", async () => {
    mocks.getAuthenticatedApp.mockResolvedValue({ data: { slug: "fixowl", id: 123456 } });
    mocks.getInstallation.mockResolvedValue({ data: { permissions: FULL_PERMS } });
    mocks.listReposPaginate.mockResolvedValue([{ full_name: "other/repo" }]);

    const errors = await collect(ctxWith(APP_GITHUB));

    expect(errors.some((error) => /not installed on o\/r/.test(error))).toBe(true);
  });

  it("fails loudly when the App cannot authenticate at all", async () => {
    mocks.getAuthenticatedApp.mockRejectedValue(new Error("bad credentials"));

    const errors = await collect(ctxWith(APP_GITHUB));

    expect(errors.some((error) => /App identity/.test(error))).toBe(true);
    expect(mocks.getInstallation).not.toHaveBeenCalled();
  });
});

interface Settings {
  agent: string;
  defaultModel?: string;
  labelModels?: Record<string, { model?: string; effort?: string }>;
}

function settingsFor(s: Settings): ResolvedRepoSettings {
  return {
    agent: s.agent,
    defaultModel: s.defaultModel,
    labelModels: s.labelModels ?? {},
  } as unknown as ResolvedRepoSettings;
}

function sinks(): {
  ok: string[];
  warn: string[];
  failed: string[];
  handlers: {
    ok: (m: string) => void;
    warn: (m: string) => void;
    failed: (m: string) => void;
  };
} {
  const ok: string[] = [];
  const warn: string[] = [];
  const failed: string[] = [];
  return {
    ok,
    warn,
    failed,
    handlers: {
      ok: (m) => ok.push(m),
      warn: (m) => warn.push(m),
      failed: (m) => failed.push(m),
    },
  };
}

describe("validateModelsAgainstLiveList", () => {
  it("passes when the configured codex model is in the live /v1/models list", async () => {
    const s = sinks();
    let fetched = false;
    await validateModelsAgainstLiveList({
      repoName: "o/r",
      settings: settingsFor({ agent: "codex", defaultModel: "gpt-5-codex" }),
      env: { OPENAI_API_KEY: "sk-test" },
      fetchJson: async () => {
        fetched = true;
        return { data: [{ id: "gpt-5-codex" }, { id: "gpt-5.1-codex" }] };
      },
      ...s.handlers,
    });
    expect(fetched).toBe(true);
    expect(s.failed).toEqual([]);
    expect(s.warn).toEqual([]);
    expect(s.ok.some((m) => /verified against the live/.test(m))).toBe(true);
  });

  it("fails when the configured model is absent from a fetched live list", async () => {
    const s = sinks();
    await validateModelsAgainstLiveList({
      repoName: "o/r",
      settings: settingsFor({ agent: "codex", defaultModel: "gpt-5-deprecated" }),
      env: { OPENAI_API_KEY: "sk-test" },
      fetchJson: async () => ({ data: [{ id: "gpt-5-codex" }] }),
      ...s.handlers,
    });
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]).toContain("gpt-5-deprecated");
    expect(s.failed[0]).toContain("OPENAI_API_KEY");
  });

  it("falls back to the catalog (warn, no hard fail) when the list cannot be fetched", async () => {
    const s = sinks();
    await validateModelsAgainstLiveList({
      repoName: "o/r",
      settings: settingsFor({ agent: "codex", defaultModel: "gpt-5-codex" }),
      env: { OPENAI_API_KEY: "sk-test" },
      fetchJson: async () => {
        throw new Error("HTTP 500");
      },
      ...s.handlers,
    });
    expect(s.failed).toEqual([]);
    expect(s.warn).toHaveLength(1);
    expect(s.warn[0]).toContain("built-in catalog");
  });

  it("is a no-op for agents with no live model list (claude/aider unaffected)", async () => {
    for (const agent of ["claude", "aider"]) {
      const s = sinks();
      let fetched = false;
      await validateModelsAgainstLiveList({
        repoName: "o/r",
        settings: settingsFor({ agent, defaultModel: "sonnet" }),
        env: { OPENAI_API_KEY: "sk-test" },
        fetchJson: async () => {
          fetched = true;
          return { data: [] };
        },
        ...s.handlers,
      });
      expect(fetched).toBe(false);
      expect(s.ok).toEqual([]);
      expect(s.warn).toEqual([]);
      expect(s.failed).toEqual([]);
    }
  });

  it("checks selector-label models too", async () => {
    const s = sinks();
    await validateModelsAgainstLiveList({
      repoName: "o/r",
      settings: settingsFor({
        agent: "codex",
        defaultModel: "gpt-5-codex",
        labelModels: { "big-job": { model: "gpt-5-missing" } },
      }),
      env: { OPENAI_API_KEY: "sk-test" },
      fetchJson: async () => ({ data: [{ id: "gpt-5-codex" }] }),
      ...s.handlers,
    });
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]).toContain("gpt-5-missing");
  });
});
