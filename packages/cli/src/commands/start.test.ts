import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { CliContext } from "../context.ts";
import type { EngineStatus } from "../docker/engine-check.ts";
import type { RunnerInfo } from "../github/runner-registration.ts";
import { startCommand, type StartDeps } from "./start.ts";

const okEngine: EngineStatus = { ok: true, engine: "colima", detail: "colima (test)" };

function makeCtx(): CliContext {
  return {
    config: { repos: [{ name: "acme/widgets" }], runner: { dir: "/tmp/fixowl-runners" } },
    admin: {} as Octokit,
  } as unknown as CliContext;
}

/** Real-looking deps, all stubbed to no-ops; each test overrides what it probes. */
function stubDeps(overrides: Partial<StartDeps> = {}): StartDeps {
  return {
    ensureEngineRunning: vi.fn(async () => okEngine),
    ensureRunnerInstalled: vi.fn(async () => "already" as const),
    isRunnerConfigured: vi.fn(() => true),
    registerRunner: vi.fn(async () => "configured" as const),
    writeRunnerEnvFile: vi.fn(),
    svcInstall: vi.fn(async () => {}),
    svcStart: vi.fn(async () => {}),
    findRunner: vi.fn(async () => undefined),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("fixowl start", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs and starts the service without registering on the routine path", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const online: RunnerInfo = {
      id: 1,
      name: "fixowl-acme-widgets",
      status: "online",
      busy: false,
    };
    const deps = stubDeps({ findRunner: vi.fn(async () => online) });

    await startCommand(makeCtx(), undefined, { deps });

    expect(deps.svcInstall).toHaveBeenCalledTimes(1);
    expect(deps.svcStart).toHaveBeenCalledTimes(1);
    // registration is the only Administration: write op; the routine path must skip it.
    expect(deps.registerRunner).not.toHaveBeenCalled();
  });

  it("does not fail when the admin token cannot query runner status (revoked/downgraded)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "log");
    const forbidden = Object.assign(new Error("forbidden"), { status: 403 });
    const deps = stubDeps({
      findRunner: vi.fn(async () => {
        throw forbidden;
      }),
    });

    await expect(startCommand(makeCtx(), undefined, { deps })).resolves.toBeUndefined();

    // Service still came up...
    expect(deps.svcInstall).toHaveBeenCalledTimes(1);
    expect(deps.svcStart).toHaveBeenCalledTimes(1);
    expect(deps.registerRunner).not.toHaveBeenCalled();
    // ...and we told the operator how to confirm online status instead of throwing.
    const printed = info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("could not confirm online status");
    expect(printed).toContain("Settings > Actions > Runners");
  });

  it("warns but does not fail when the runner never reports online", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = stubDeps({ findRunner: vi.fn(async () => undefined) });

    await expect(startCommand(makeCtx(), undefined, { deps })).resolves.toBeUndefined();

    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("did not report online");
    expect(deps.registerRunner).not.toHaveBeenCalled();
  });

  it("throws an actionable error when the runner is not registered and --register was not passed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ isRunnerConfigured: vi.fn(() => false) });

    await expect(startCommand(makeCtx(), undefined, { deps })).rejects.toThrow(
      /not registered on this host/,
    );
    expect(deps.svcInstall).not.toHaveBeenCalled();
    expect(deps.registerRunner).not.toHaveBeenCalled();
  });

  it("registers first when --register is passed (explicit setup path for another host)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const register = vi.fn(async () => "configured" as const);
    const deps = stubDeps({ registerRunner: register });

    await startCommand(makeCtx(), undefined, { register: true, deps });

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: "acme/widgets" }),
    );
    expect(deps.svcInstall).toHaveBeenCalledTimes(1);
    expect(deps.svcStart).toHaveBeenCalledTimes(1);
  });
});
