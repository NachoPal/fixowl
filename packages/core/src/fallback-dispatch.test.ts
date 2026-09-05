import { describe, expect, it } from "vitest";
import {
  anchorOccurrence,
  decideFallbackDispatch,
  guardScheduledSlot,
  isSameUtcDay,
  isScheduledSlotRun,
  scheduledRunToday,
  tryParseDailyCron,
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

describe("tryParseDailyCron", () => {
  it("parses a plain daily M H * * * cron", () => {
    expect(tryParseDailyCron("55 23 * * *")).toEqual({ hourUtc: 23, minuteUtc: 55 });
    expect(tryParseDailyCron("18 5 * * *")).toEqual({ hourUtc: 5, minuteUtc: 18 });
  });

  it("returns undefined for a non-daily or malformed cron", () => {
    expect(tryParseDailyCron("*/15 * * * *")).toBeUndefined(); // stepped minute
    expect(tryParseDailyCron("0 5 * * 1")).toBeUndefined(); // weekday restricted
    expect(tryParseDailyCron("0 5 1 * *")).toBeUndefined(); // day-of-month restricted
    expect(tryParseDailyCron("18 5 * *")).toBeUndefined(); // too few fields
    expect(tryParseDailyCron("99 5 * * *")).toBeUndefined(); // minute out of range
    expect(tryParseDailyCron("")).toBeUndefined();
  });
});

describe("anchorOccurrence", () => {
  it("returns today's occurrence when now is after the cron time (UTC)", () => {
    // cron 05:18 UTC, now 06:30 same day -> anchor is today 05:18.
    expect(
      anchorOccurrence(
        { hourUtc: 5, minuteUtc: 18 },
        new Date("2026-09-05T06:30:00Z"),
      ).toISOString(),
    ).toBe("2026-09-05T05:18:00.000Z");
  });

  it("returns the previous day's occurrence when now is before the cron time", () => {
    // cron 23:55 UTC, now Tue 00:25 -> most recent occurrence is Mon 23:55.
    expect(
      anchorOccurrence(
        { hourUtc: 23, minuteUtc: 55 },
        new Date("2026-09-08T00:25:00Z"),
      ).toISOString(),
    ).toBe("2026-09-07T23:55:00.000Z");
  });

  it("returns now's instant exactly at the cron time", () => {
    expect(
      anchorOccurrence(
        { hourUtc: 5, minuteUtc: 18 },
        new Date("2026-09-05T05:18:00Z"),
      ).toISOString(),
    ).toBe("2026-09-05T05:18:00.000Z");
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

  describe("anchored occurrence window (cron passed)", () => {
    // The near-midnight case the anchored window exists for: cron 23:55 UTC
    // fires on Monday, the fallback pre-check runs Tuesday 00:25. anchor(Tue
    // 00:25) = Mon 23:55, so the Monday schedule run is >= anchor and the
    // fallback must stand down. A plain UTC-calendar-day check would look only
    // at Tuesday, miss Monday's run, and wrongly dispatch a duplicate.
    const CRON = "55 23 * * *";
    const tueAfterMidnight = new Date("2026-09-08T00:25:00Z");
    const mondayCron = run({ id: 100, createdAt: "2026-09-07T23:55:00Z" });

    it("stands down: sees Monday's on-time cron from the post-midnight check", () => {
      const decision = decideFallbackDispatch([mondayCron], tueAfterMidnight, CRON);
      expect(decision.dispatch).toBe(false);
      expect(decision.existing?.id).toBe(100);
    });

    it("a UTC-calendar-day check (no cron) would wrongly dispatch the same case", () => {
      // Demonstrates why anchoring is needed: without the cron, the day-based
      // fallback misses Monday's run.
      expect(decideFallbackDispatch([mondayCron], tueAfterMidnight).dispatch).toBe(true);
    });

    it("still dispatches when the last cron predates the current anchor", () => {
      // A cron run from the occurrence *before* the current one does not cover.
      const staleCron = run({ id: 100, createdAt: "2026-09-06T23:55:00Z" });
      expect(decideFallbackDispatch([staleCron], tueAfterMidnight, CRON).dispatch).toBe(true);
    });

    it("same-day cron: a late cron after its anchor stands the fallback down", () => {
      // cron 05:18 UTC, now 06:30 same day, an on-time schedule run at 05:18.
      const decision = decideFallbackDispatch(
        [run({ id: 100, createdAt: "2026-09-05T05:18:00Z" })],
        new Date("2026-09-05T06:30:00Z"),
        "18 5 * * *",
      );
      expect(decision.dispatch).toBe(false);
    });
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

  describe("anchored occurrence window (cronSchedule passed)", () => {
    // Cross-midnight: an on-time cron just before UTC midnight and its
    // post-midnight fallback must dedupe to one run. The anchored window keeps
    // both in one occurrence; a UTC-calendar-day window would not.
    const CRON = "55 23 * * *";
    const tueAfterMidnight = new Date("2026-09-08T00:25:00Z");
    const mondayCron = run({ id: 100, event: "schedule", createdAt: "2026-09-07T23:55:00Z" });
    const tuesdayFallback = fallbackRun({ id: 200, createdAt: "2026-09-08T00:25:00Z" });

    it("stands a post-midnight fallback down when the on-time cron already covered the occurrence", () => {
      const result = guardScheduledSlot({
        ...base,
        now: tueAfterMidnight,
        cronSchedule: CRON,
        runs: [mondayCron, tuesdayFallback],
        currentRunId: 200,
        selfIsScheduledSlot: true,
      });
      expect(result.proceed).toBe(false);
      expect(result.supersededBy?.id).toBe(100);
    });

    it("would wrongly let the post-midnight fallback proceed under a UTC-calendar-day window (no cron)", () => {
      // Same runs, no cron: the day-based window puts Monday's cron and the
      // Tuesday fallback on different days, so the guard fails to dedupe.
      const result = guardScheduledSlot({
        ...base,
        now: tueAfterMidnight,
        runs: [mondayCron, tuesdayFallback],
        currentRunId: 200,
        selfIsScheduledSlot: true,
      });
      expect(result.proceed).toBe(true);
    });

    it("ignores a cron from the previous occurrence", () => {
      // A cron from two nights ago (before the current anchor) does not cover.
      const staleCron = run({ id: 100, event: "schedule", createdAt: "2026-09-06T23:55:00Z" });
      const result = guardScheduledSlot({
        ...base,
        now: tueAfterMidnight,
        cronSchedule: CRON,
        runs: [staleCron, tuesdayFallback],
        currentRunId: 200,
        selfIsScheduledSlot: true,
      });
      expect(result.proceed).toBe(true);
    });

    it("same-day cron: stands a late cron down when an earlier fallback covered the occurrence", () => {
      // cron 05:18 UTC; a fallback at 05:48 then a late cron at 06:30, same day.
      const result = guardScheduledSlot({
        ...base,
        now: new Date("2026-09-05T06:30:00Z"),
        cronSchedule: "18 5 * * *",
        runs: [
          fallbackRun({ id: 100, createdAt: "2026-09-05T05:48:00Z" }),
          run({ id: 200, event: "schedule", createdAt: "2026-09-05T06:30:00Z" }),
        ],
        currentRunId: 200,
        selfIsScheduledSlot: true,
      });
      expect(result.proceed).toBe(false);
      expect(result.supersededBy?.id).toBe(100);
    });
  });
});
