import { describe, expect, it } from "vitest";
import {
  decideFallbackDispatch,
  guardScheduledSlot,
  isSameUtcDay,
  isScheduledSlotRun,
  scheduledRunToday,
  SCHEDULED_FALLBACK_MARKER,
  type WorkflowRunLite,
} from "./fallback-dispatch.ts";

function run(overrides: Partial<WorkflowRunLite> = {}): WorkflowRunLite {
  return {
    id: 1,
    event: "schedule",
    status: "completed",
    createdAt: "2026-09-05T05:18:03Z",
    displayTitle: "fixowl night run",
    ...overrides,
  };
}

/** A fallback-tagged dispatch, whose run-name carries the marker. */
function fallbackRun(overrides: Partial<WorkflowRunLite> = {}): WorkflowRunLite {
  return run({
    event: "workflow_dispatch",
    displayTitle: `fixowl night run ${SCHEDULED_FALLBACK_MARKER}`,
    ...overrides,
  });
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

describe("isScheduledSlotRun", () => {
  it("treats every schedule run as a scheduled-slot run", () => {
    expect(isScheduledSlotRun(run({ event: "schedule" }))).toBe(true);
  });

  it("treats a fallback-tagged dispatch as a scheduled-slot run", () => {
    expect(isScheduledSlotRun(fallbackRun())).toBe(true);
  });

  it("does not treat a plain manual dispatch as a scheduled-slot run", () => {
    expect(
      isScheduledSlotRun(run({ event: "workflow_dispatch", displayTitle: "fixowl night run" })),
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

  it("dispatches when only a prior fallback dispatch happened (no cron yet)", () => {
    // Layer 1 keys strictly off the schedule event; the in-run slot guard is
    // what collapses a double-fallback, so the pre-check still dispatches here.
    expect(decideFallbackDispatch([fallbackRun({ id: 12 })], NOW).dispatch).toBe(true);
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
});

describe("guardScheduledSlot", () => {
  const base = { now: NOW, marker: SCHEDULED_FALLBACK_MARKER };

  it("never blocks a run that is not itself a scheduled-slot run (manual dispatch)", () => {
    const result = guardScheduledSlot({
      ...base,
      runs: [run({ id: 100, event: "schedule" })],
      currentRunId: 200,
      selfIsScheduledSlot: false,
    });
    expect(result.proceed).toBe(true);
  });

  it("proceeds for the first scheduled-slot run of the day", () => {
    const result = guardScheduledSlot({
      ...base,
      runs: [run({ id: 200, event: "schedule" })],
      currentRunId: 200,
      selfIsScheduledSlot: true,
    });
    expect(result.proceed).toBe(true);
    expect(result.reason).toContain("first scheduled-slot run");
  });

  it("stands a late cron down when an earlier fallback run already covered today", () => {
    const result = guardScheduledSlot({
      ...base,
      runs: [fallbackRun({ id: 100, status: "in_progress" }), run({ id: 200, event: "schedule" })],
      currentRunId: 200,
      selfIsScheduledSlot: true,
    });
    expect(result.proceed).toBe(false);
    expect(result.supersededBy?.id).toBe(100);
  });

  it("stands a late fallback down when an earlier cron already covered today", () => {
    const result = guardScheduledSlot({
      ...base,
      runs: [run({ id: 100, event: "schedule" }), fallbackRun({ id: 200 })],
      currentRunId: 200,
      selfIsScheduledSlot: true,
    });
    expect(result.proceed).toBe(false);
    expect(result.supersededBy?.id).toBe(100);
  });

  it("ignores manual dispatches when deciding whether the slot is covered", () => {
    const result = guardScheduledSlot({
      ...base,
      runs: [
        run({ id: 50, event: "workflow_dispatch", displayTitle: "fixowl night run" }),
        run({ id: 200, event: "schedule" }),
      ],
      currentRunId: 200,
      selfIsScheduledSlot: true,
    });
    // The lower-id run (#50) is a plain manual dispatch, so it does not cover
    // the slot; the schedule run #200 still proceeds.
    expect(result.proceed).toBe(true);
  });

  it("ignores earlier scheduled-slot runs from previous days", () => {
    const result = guardScheduledSlot({
      ...base,
      runs: [
        run({ id: 100, event: "schedule", createdAt: "2026-09-04T05:18:00Z" }),
        run({ id: 200, event: "schedule" }),
      ],
      currentRunId: 200,
      selfIsScheduledSlot: true,
    });
    expect(result.proceed).toBe(true);
  });

  it("is deterministic in a same-instant race: only the lowest-id slot run proceeds", () => {
    const runs = [
      run({ id: 100, event: "schedule", createdAt: "2026-09-05T05:48:00Z" }),
      fallbackRun({ id: 101, createdAt: "2026-09-05T05:48:00Z" }),
    ];
    expect(
      guardScheduledSlot({ ...base, runs, currentRunId: 100, selfIsScheduledSlot: true }).proceed,
    ).toBe(true);
    expect(
      guardScheduledSlot({ ...base, runs, currentRunId: 101, selfIsScheduledSlot: true }).proceed,
    ).toBe(false);
  });
});
