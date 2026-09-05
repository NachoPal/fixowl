import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunLite } from "@fixowl/core";
import type { CliContext } from "../context.ts";
import { fallbackCheckCommand, type FallbackCheckDeps } from "./fallback.ts";

function makeCtx(): CliContext {
  return {
    config: {
      version: 1,
      github: { admin_token: "a", runtime_token: "r", fallback_token: "f" },
      repos: [{ name: "acme/widgets" }],
    },
  } as unknown as CliContext;
}

const NOW = new Date("2026-09-05T05:48:00Z");

function scheduleRunToday(): WorkflowRunLite {
  return {
    id: 1,
    event: "schedule",
    status: "completed",
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
      createdAt: "2026-09-05T04:00:00Z",
      displayTitle: "fixowl night run",
    };
    const deps = stubDeps({ listRecentRuns: vi.fn(async () => [manual]) });

    await fallbackCheckCommand(makeCtx(), "acme/widgets", deps);

    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });
});
