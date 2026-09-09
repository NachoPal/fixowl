import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleTrigger, WorkflowRunLite } from "@fixowl/core";
import type { CliContext } from "../context.ts";
import { fallbackCheckCommand, type FallbackCheckDeps } from "./fallback.ts";

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

function stubDeps(overrides: Partial<FallbackCheckDeps> = {}): FallbackCheckDeps {
  return {
    listRecentRuns: vi.fn(async () => []),
    getDefaultBranch: vi.fn(async () => "main"),
    dispatch: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides,
  };
}

describe("fixowl fallback check", () => {
  afterEach(() => vi.restoreAllMocks());

  it("dispatches (tagged) when today's cron run is missing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => []) });

    await fallbackCheckCommand(makeCtx(), "acme/widgets", deps);

    expect(deps.getDefaultBranch).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith({ owner: "acme", repo: "widgets" }, "main");
  });

  it("stands down when today's cron run already exists", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => [scheduleRunToday()]) });

    await fallbackCheckCommand(makeCtx(), "acme/widgets", deps);

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

    await fallbackCheckCommand(makeCtx(), "acme/widgets", deps);

    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it("never dispatches for a github-cron repo (no host trigger)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => []) });

    await fallbackCheckCommand(makeCtx("github-cron"), "acme/widgets", deps);

    expect(deps.listRecentRuns).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("host-scheduler: dispatches directly even with no schedule run (dispatch-only workflow, #81)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => []) });

    await fallbackCheckCommand(makeCtx("host-scheduler"), "acme/widgets", deps);

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

    await fallbackCheckCommand(makeCtx("host-scheduler"), "acme/widgets", deps);

    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
