import { describe, expect, it } from "vitest";
import {
  decideFallbackDispatch,
  isSameUtcDay,
  scheduledRunToday,
  type WorkflowRunLite,
} from "./fallback-dispatch.ts";

function run(overrides: Partial<WorkflowRunLite> = {}): WorkflowRunLite {
  return {
    id: 1,
    event: "schedule",
    status: "completed",
    createdAt: "2026-09-05T05:18:03Z",
    ...overrides,
  };
}

const NOW = new Date("2026-09-05T05:48:00Z");

describe("isSameUtcDay", () => {
  it("compares on the UTC calendar day, ignoring the time of day", () => {
    expect(isSameUtcDay(new Date("2026-09-05T00:00:00Z"), new Date("2026-09-05T23:59:59Z"))).toBe(
      true,
    );
    expect(isSameUtcDay(new Date("2026-09-05T23:00:00Z"), new Date("2026-09-06T01:00:00Z"))).toBe(
      false,
    );
  });

  it("uses UTC, not the host's local timezone", () => {
    // 2026-09-05T23:30-07:00 is 2026-09-06T06:30Z: a different UTC day.
    expect(
      isSameUtcDay(new Date("2026-09-05T23:30:00-07:00"), new Date("2026-09-05T12:00:00Z")),
    ).toBe(false);
  });
});

describe("scheduledRunToday", () => {
  it("finds a schedule-event run created today", () => {
    expect(scheduledRunToday([run()], NOW)?.id).toBe(1);
  });

  it("ignores schedule runs from other days", () => {
    expect(scheduledRunToday([run({ createdAt: "2026-09-04T05:18:00Z" })], NOW)).toBeUndefined();
  });

  it("ignores workflow_dispatch runs even if created today", () => {
    expect(
      scheduledRunToday(
        [run({ event: "workflow_dispatch", createdAt: "2026-09-05T05:18:00Z" })],
        NOW,
      ),
    ).toBeUndefined();
  });

  it("matches a schedule run in any status, including queued and in_progress", () => {
    for (const status of ["queued", "in_progress", "completed", null]) {
      expect(scheduledRunToday([run({ status })], NOW)?.id).toBe(1);
    }
  });
});

describe("decideFallbackDispatch", () => {
  it("dispatches when there is no run at all today", () => {
    const decision = decideFallbackDispatch([], NOW);
    expect(decision.dispatch).toBe(true);
    expect(decision.existing).toBeUndefined();
    expect(decision.reason).toContain("workflow_dispatch");
  });

  it("dispatches when only manual dispatch runs happened today (cron still missing)", () => {
    const runs = [
      run({ id: 10, event: "workflow_dispatch", createdAt: "2026-09-05T04:00:00Z" }),
      run({ id: 11, event: "workflow_dispatch", createdAt: "2026-09-05T05:00:00Z" }),
    ];
    expect(decideFallbackDispatch(runs, NOW).dispatch).toBe(true);
  });

  it("stands down when today's scheduled run exists (any status)", () => {
    const decision = decideFallbackDispatch([run({ status: "in_progress" })], NOW);
    expect(decision.dispatch).toBe(false);
    expect(decision.existing?.id).toBe(1);
    expect(decision.reason).toContain("cron is healthy");
  });

  it("dispatches when the only schedule run is from a previous day", () => {
    expect(decideFallbackDispatch([run({ createdAt: "2026-09-04T05:18:00Z" })], NOW).dispatch).toBe(
      true,
    );
  });

  it("stands down even when a manual run also happened today alongside the cron", () => {
    const runs = [
      run({ id: 20, event: "workflow_dispatch", createdAt: "2026-09-05T04:00:00Z" }),
      run({ id: 21, event: "schedule", createdAt: "2026-09-05T05:18:00Z" }),
    ];
    const decision = decideFallbackDispatch(runs, NOW);
    expect(decision.dispatch).toBe(false);
    expect(decision.existing?.id).toBe(21);
  });
});
