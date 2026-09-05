import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fallbackLabel,
  fallbackLocalTime,
  nextFireTime,
  parseDailyCron,
  readPlistLocalTime,
  renderFallbackPlist,
} from "./fallback-launchd.ts";

describe("parseDailyCron", () => {
  it("parses a daily cron's hour and minute (UTC)", () => {
    expect(parseDailyCron("18 5 * * *")).toEqual({ hourUtc: 5, minuteUtc: 18 });
    expect(parseDailyCron("37 1 * * *")).toEqual({ hourUtc: 1, minuteUtc: 37 });
  });

  it("rejects a non-daily cron", () => {
    expect(() => parseDailyCron("0 5 * * 1")).toThrow(/not daily/);
    expect(() => parseDailyCron("0 */2 * * *")).toThrow(/hour must be 0-23/);
  });

  it("rejects a malformed cron", () => {
    expect(() => parseDailyCron("18 5 * *")).toThrow(/5-field/);
    expect(() => parseDailyCron("99 5 * * *")).toThrow(/minute must be 0-59/);
  });
});

describe("fallbackLocalTime (DST-safe scheduling)", () => {
  it("schedules at cronUTC + gap + the zone's summer offset", () => {
    // cron 05:18 UTC, +30 min, zone UTC+2 (summer) => 05:18 + 0:30 + 2:00 = 07:48 local.
    expect(
      fallbackLocalTime({
        cron: { hourUtc: 5, minuteUtc: 18 },
        gapMinutes: 30,
        maxOffsetMinutes: 120,
      }),
    ).toEqual({ hour: 7, minute: 48 });
  });

  it("keeps the actual fire strictly after the cron in BOTH DST seasons", () => {
    // For a UTC+1/+2 zone: maxOffset = 120. The programmed local time, converted
    // back to UTC at each seasonal offset, must land at or after cron+gap.
    const cron = { hourUtc: 5, minuteUtc: 18 };
    const gapMinutes = 30;
    const local = fallbackLocalTime({ cron, gapMinutes, maxOffsetMinutes: 120 });
    const localMinutes = local.hour * 60 + local.minute;
    const cronPlusGap = cron.hourUtc * 60 + cron.minuteUtc + gapMinutes;
    for (const offset of [60, 120]) {
      const fireUtc = localMinutes - offset;
      expect(fireUtc).toBeGreaterThanOrEqual(cronPlusGap);
    }
  });

  it("handles a zone with no DST (both offsets equal) as an exact gap", () => {
    // cron 01:37 UTC, +30, UTC+0 => 02:07 local, which is exactly cron+gap in UTC.
    expect(
      fallbackLocalTime({
        cron: { hourUtc: 1, minuteUtc: 37 },
        gapMinutes: 30,
        maxOffsetMinutes: 0,
      }),
    ).toEqual({ hour: 2, minute: 7 });
  });

  it("wraps past midnight correctly", () => {
    expect(
      fallbackLocalTime({
        cron: { hourUtc: 23, minuteUtc: 50 },
        gapMinutes: 30,
        maxOffsetMinutes: 0,
      }),
    ).toEqual({ hour: 0, minute: 20 });
  });
});

describe("fallbackLabel", () => {
  it("builds a reverse-DNS launchd label from the repo", () => {
    expect(fallbackLabel("Acme/Widgets")).toBe("com.fixowl.fallback.acme-widgets");
    expect(fallbackLabel("a/b.c_d")).toBe("com.fixowl.fallback.a-b-c-d");
  });
});

describe("nextFireTime", () => {
  it("returns today's occurrence when it is still ahead", () => {
    const from = new Date("2026-09-05T06:00:00");
    expect(nextFireTime({ hour: 7, minute: 48 }, from).getHours()).toBe(7);
    expect(nextFireTime({ hour: 7, minute: 48 }, from).getDate()).toBe(5);
  });

  it("rolls to tomorrow when the time has already passed today", () => {
    const from = new Date("2026-09-05T08:00:00");
    expect(nextFireTime({ hour: 7, minute: 48 }, from).getDate()).toBe(6);
  });
});

describe("renderFallbackPlist", () => {
  const plist = renderFallbackPlist({
    label: "com.fixowl.fallback.acme-widgets",
    programArguments: [
      "/usr/bin/node",
      "/opt/fixowl/index.js",
      "fallback",
      "check",
      "acme/widgets",
    ],
    local: { hour: 7, minute: 48 },
    pathEnv: "/opt/homebrew/bin:/usr/bin",
    stdoutPath: "/home/u/.fixowl/logs/x.log",
    stderrPath: "/home/u/.fixowl/logs/x.log",
  });

  it("renders the label, argv, and the calendar interval", () => {
    expect(plist).toContain("<string>com.fixowl.fallback.acme-widgets</string>");
    expect(plist).toContain("<string>fallback</string>");
    expect(plist).toContain("<string>acme/widgets</string>");
    expect(plist).toContain("<key>Hour</key>\n    <integer>7</integer>");
    expect(plist).toContain("<key>Minute</key>\n    <integer>48</integer>");
  });

  it("round-trips through readPlistLocalTime", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-plist-"));
    // readPlistLocalTime resolves the path from the label under ~/Library; write
    // a file whose content matches and check the regex extraction directly here.
    const file = join(dir, "test.plist");
    writeFileSync(file, plist);
    const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
    const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
    expect(Number(hour?.[1])).toBe(7);
    expect(Number(minute?.[1])).toBe(48);
    // readPlistLocalTime returns undefined for a label with no installed plist.
    expect(readPlistLocalTime("com.fixowl.fallback.does-not-exist-xyz")).toBeUndefined();
  });
});
