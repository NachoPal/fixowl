import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { registerRunner, type RegisterRunnerDeps } from "./register.ts";

const admin = {} as Octokit;
const ref = { owner: "acme", repo: "widgets" };

function deps(overrides: Partial<RegisterRunnerDeps>): { deps: Partial<RegisterRunnerDeps> } {
  return { deps: overrides };
}

describe("registerRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads the binary, fetches a token, and configures when not yet registered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ensureRunnerInstalled = vi.fn(async () => "installed" as const);
    const getRegistrationToken = vi.fn(async () => "reg-token");
    const configureRunner = vi.fn(async () => "configured" as const);

    const result = await registerRunner({
      admin,
      ref,
      dir: "/runners/acme__widgets",
      repoFullName: "acme/widgets",
      ...deps({
        ensureRunnerInstalled,
        isRunnerConfigured: () => false,
        getRegistrationToken,
        configureRunner,
      }),
    });

    expect(result).toBe("configured");
    expect(ensureRunnerInstalled).toHaveBeenCalledWith("/runners/acme__widgets");
    expect(getRegistrationToken).toHaveBeenCalledWith(admin, ref);
    expect(configureRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: "/runners/acme__widgets",
        repoFullName: "acme/widgets",
        registrationToken: "reg-token",
        runnerName: "fixowl-acme-widgets",
      }),
    );
  });

  it("is idempotent: skips token fetch and configure when already registered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const getRegistrationToken = vi.fn(async () => "reg-token");
    const configureRunner = vi.fn(async () => "configured" as const);

    const result = await registerRunner({
      admin,
      ref,
      dir: "/runners/acme__widgets",
      repoFullName: "acme/widgets",
      ...deps({
        ensureRunnerInstalled: async () => "already",
        isRunnerConfigured: () => true,
        getRegistrationToken,
        configureRunner,
      }),
    });

    expect(result).toBe("already");
    expect(getRegistrationToken).not.toHaveBeenCalled();
    expect(configureRunner).not.toHaveBeenCalled();
  });
});
