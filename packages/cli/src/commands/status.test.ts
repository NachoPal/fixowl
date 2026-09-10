import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN_MISSING_MESSAGE, type CliContext } from "../context.ts";
import { statusCommand } from "./status.ts";

// Stub the OS-touching edges so the test exercises only the admin-token
// degradation logic, not launchd state. The runner dir does not exist, so the
// service is reported "not installed" and svcStatus is never reached.
vi.mock("../runner/launchd.ts", () => ({ svcStatus: async () => "running" }));
vi.mock("../runner/fallback-launchd.ts", () => ({
  fallbackLabel: () => "com.fixowl.acme-widgets",
  isFallbackInstalled: () => false,
  isFallbackLoaded: async () => false,
  nextFireTime: () => new Date(),
  readPlistLocalTime: () => undefined,
}));

/**
 * A context whose admin client is unavailable - the setup-only admin token was
 * revoked/removed after provisioning (issue #80). Every admin read in `status`
 * must degrade to a note rather than throw.
 */
function makeCtxNoAdmin(): CliContext {
  return {
    config: { repos: [{ name: "acme/widgets" }], runner: { dir: "/tmp/fixowl-runners" } },
    get admin() {
      throw new Error(ADMIN_TOKEN_MISSING_MESSAGE);
    },
  } as unknown as CliContext;
}

describe("fixowl status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs and degrades every admin-backed read when no admin token is present (issue #80)", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(statusCommand(makeCtxNoAdmin(), undefined)).resolves.toBeUndefined();

    const printed = info.mock.calls.map((c) => String(c[0])).join("\n");
    // Local (token-free) state still reported...
    expect(printed).toContain("acme/widgets");
    // ...and each admin read degrades to a note instead of throwing.
    expect(printed).toContain("runner:  unknown");
    expect(printed).toContain("open fixowl PRs: unknown");
  });
});
