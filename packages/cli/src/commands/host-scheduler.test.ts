import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleTrigger, WorkflowRunLite } from "@fixowl/core";
import type { CliContext } from "../context.ts";
import * as launchd from "../runner/host-scheduler-launchd.ts";
import {
  hostSchedulerCheckCommand,
  hostSchedulerInstallCommand,
  type HostSchedulerCheckDeps,
} from "./host-scheduler.ts";

function makeCtx(scheduleTrigger?: ScheduleTrigger): CliContext {
  return {
    config: {
      version: 1,
      github: {
        admin_token: "a",
        app: { app_id: 1, installation_id: 2, private_key: "pem" },
        fallback_token: "f",
      },
      repos: [{ name: "acme/widgets", schedule_trigger: scheduleTrigger }],
    },
  } as unknown as CliContext;
}

const NOW = new Date("2026-09-05T05:48:00Z");

function scheduleRunToday(): WorkflowRunLite {
  return {
    id: 1,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-09-05T05:18:00Z",
    displayTitle: "fixowl night run",
  };
}

function stubDeps(overrides: Partial<HostSchedulerCheckDeps> = {}): HostSchedulerCheckDeps {
  return {
    listRecentRuns: vi.fn(async () => []),
    getDefaultBranch: vi.fn(async () => "main"),
    dispatch: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides,
  };
}

describe("fixowl host-scheduler check", () => {
  afterEach(() => vi.restoreAllMocks());

  it("dispatches (tagged) when today's cron run is missing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => []) });

    await hostSchedulerCheckCommand(makeCtx(), "acme/widgets", deps);

    expect(deps.getDefaultBranch).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith({ owner: "acme", repo: "widgets" }, "main");
  });

  it("stands down when today's cron run already exists", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => [scheduleRunToday()]) });

    await hostSchedulerCheckCommand(makeCtx(), "acme/widgets", deps);

    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.getDefaultBranch).not.toHaveBeenCalled();
  });

  it("ignores manual dispatch runs (still dispatches when only they exist)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const manual: WorkflowRunLite = {
      id: 2,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      createdAt: "2026-09-05T04:00:00Z",
      displayTitle: "fixowl night run",
    };
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => [manual]) });

    await hostSchedulerCheckCommand(makeCtx(), "acme/widgets", deps);

    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it("never dispatches for a github-cron repo (no host trigger)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => []) });

    await hostSchedulerCheckCommand(makeCtx("github-cron"), "acme/widgets", deps);

    expect(deps.listRecentRuns).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("host-scheduler: dispatches directly even with no schedule run (dispatch-only workflow, #81)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => []) });

    await hostSchedulerCheckCommand(makeCtx("host-scheduler"), "acme/widgets", deps);

    expect(deps.dispatch).toHaveBeenCalledWith({ owner: "acme", repo: "widgets" }, "main");
  });

  it("host-scheduler: stands down when its own prior tagged dispatch covers the occurrence", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tagged: WorkflowRunLite = {
      id: 3,
      event: "workflow_dispatch",
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-09-05T05:40:00Z",
      displayTitle: "fixowl night run [scheduled-fallback]",
    };
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => [tagged]) });

    await hostSchedulerCheckCommand(makeCtx("host-scheduler"), "acme/widgets", deps);

    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});

describe("fixowl host-scheduler install (legacy migration)", () => {
  const realPlatform = process.platform;
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  it("removes a pre-existing com.fixowl.fallback.<repo> agent before installing the new one", async () => {
    // launchd install is macOS-only; pretend we are on it so the test is portable.
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const install = vi
      .spyOn(launchd, "installHostSchedulerAgent")
      .mockImplementation(async () => {});
    // Return true so the command reports it migrated a legacy agent.
    const uninstall = vi
      .spyOn(launchd, "uninstallHostSchedulerAgent")
      .mockImplementation(async () => true);

    await hostSchedulerInstallCommand(makeCtx(), "acme/widgets", undefined);

    // The old-label agent is booted out/removed via uninstall before install,
    // and the new agent is installed under the new label.
    expect(uninstall).toHaveBeenCalledWith("com.fixowl.fallback.acme-widgets");
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[0]?.label).toBe("com.fixowl.host-scheduler.acme-widgets");
    // Migration happened before the install.
    expect(uninstall.mock.invocationCallOrder[0]).toBeLessThan(
      install.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
