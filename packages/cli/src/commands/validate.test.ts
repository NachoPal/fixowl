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

const { validateRuntimeCredential } = await import("./validate.ts");

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
