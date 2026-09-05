import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, runOrThrow } from "../exec.ts";

/**
 * The optional local fallback trigger runs as a per-user launchd agent (one per
 * target repo) that fires daily after the repo's cron and runs
 * `fixowl fallback check <repo>`. We write and drive our own plist here rather
 * than reusing the runner's bundled `svc.sh`, which only knows the runner
 * service.
 *
 * The hard part is time zones. GitHub's cron is fixed UTC; launchd's
 * StartCalendarInterval fires in the host's LOCAL wall-clock time, which shifts
 * an hour with DST. To keep the fallback reliably *after* the cron in every
 * season we schedule it at the local time of `cronUTC + gap + the zone's larger
 * (summer) UTC offset`. That makes the actual fire land between `gap` and
 * `gap + (DST swing)` after the cron all year, never before it - see
 * {@link fallbackLocalTime}. Because the "already ran today?" decision keys on
 * the UTC calendar day, exact timing is not critical as long as the fire stays
 * after the cron, which this guarantees.
 */

const MINUTES_PER_DAY = 24 * 60;

export interface DailyCronTime {
  hourUtc: number;
  minuteUtc: number;
}

/**
 * Parses the hour/minute of a daily `M H * * *` cron (UTC). The fallback needs a
 * single daily fire time; anything more elaborate (ranges, steps, lists, or a
 * non-`*` day/month/weekday) is rejected with a clear message.
 */
export function parseDailyCron(cron: string): DailyCronTime {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected a 5-field cron, got "${cron}"`);
  }
  const [minute, hour, dom, month, dow] = fields;
  if (dom !== "*" || month !== "*" || dow !== "*") {
    throw new Error(
      `the local fallback needs a plain daily cron like "M H * * *"; "${cron}" is not daily`,
    );
  }
  const minuteUtc = Number(minute);
  const hourUtc = Number(hour);
  if (!Number.isInteger(minuteUtc) || minuteUtc < 0 || minuteUtc > 59) {
    throw new Error(`cron minute must be 0-59, got "${minute}"`);
  }
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new Error(`cron hour must be 0-23, got "${hour}"`);
  }
  return { hourUtc, minuteUtc };
}

export interface LocalTime {
  hour: number;
  minute: number;
}

/**
 * The local wall-clock time to program into launchd so the fallback fires after
 * the UTC cron in every DST season. See the module comment for the reasoning.
 *
 * @param maxOffsetMinutes the larger of the zone's two UTC offsets (its summer /
 *   DST offset), in minutes east of UTC.
 */
export function fallbackLocalTime(params: {
  cron: DailyCronTime;
  gapMinutes: number;
  maxOffsetMinutes: number;
}): LocalTime {
  const utcMinuteOfDay = params.cron.hourUtc * 60 + params.cron.minuteUtc;
  const total = utcMinuteOfDay + params.gapMinutes + params.maxOffsetMinutes;
  const localMinuteOfDay = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return {
    hour: Math.floor(localMinuteOfDay / 60),
    minute: localMinuteOfDay % 60,
  };
}

/**
 * The larger of the host zone's two UTC offsets over the year, in minutes east
 * of UTC. Sampling January and July covers both DST states in either
 * hemisphere; a zone without DST returns the same value for both.
 */
export function hostMaxOffsetMinutes(reference: Date = new Date()): number {
  const year = reference.getFullYear();
  // getTimezoneOffset() returns minutes where local = UTC - value, so the offset
  // east of UTC is its negation.
  const january = -new Date(year, 0, 1).getTimezoneOffset();
  const july = -new Date(year, 6, 1).getTimezoneOffset();
  return Math.max(january, july);
}

/** Next local occurrence of a daily wall-clock time, from `from`. */
export function nextFireTime(local: LocalTime, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setHours(local.hour, local.minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** launchd label for a repo's fallback agent, e.g. com.fixowl.fallback.owner-repo. */
export function fallbackLabel(repoFullName: string): string {
  const slug = repoFullName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `com.fixowl.fallback.${slug}`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface FallbackPlistParams {
  label: string;
  /** argv the agent runs, e.g. [node, cliScript, "fallback", "check", repo]. */
  programArguments: readonly string[];
  local: LocalTime;
  /** PATH for the agent process, so node/git resolve under launchd. */
  pathEnv: string;
  stdoutPath: string;
  stderrPath: string;
}

/** Renders the launchd property list for a repo's fallback agent (pure). */
export function renderFallbackPlist(params: FallbackPlistParams): string {
  const args = params.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(params.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${params.local.hour}</integer>
    <key>Minute</key>
    <integer>${params.local.minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(params.pathEnv)}</string>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(params.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(params.stderrPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// I/O: writing the plist and driving launchctl. Pure logic above stays testable.
// ---------------------------------------------------------------------------

/** Default PATH for the agent, covering Homebrew on Intel and Apple Silicon. */
export const FALLBACK_PATH_ENV = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

export function fallbackPlistPath(label: string): string {
  return join(launchAgentsDir(), `${label}.plist`);
}

export function fallbackLogPath(label: string): string {
  return join(homedir(), ".fixowl", "logs", `${label}.log`);
}

export function isFallbackInstalled(label: string): boolean {
  return existsSync(fallbackPlistPath(label));
}

/** gui/<uid> domain target for a per-user launchd agent. */
function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/**
 * Writes the plist and (re)loads it via launchctl. Idempotent: an existing agent
 * is booted out first so the new calendar interval takes effect.
 */
export async function installFallbackAgent(params: {
  label: string;
  plist: string;
}): Promise<void> {
  mkdirSync(launchAgentsDir(), { recursive: true });
  mkdirSync(join(homedir(), ".fixowl", "logs"), { recursive: true });
  const path = fallbackPlistPath(params.label);
  writeFileSync(path, params.plist);
  // Best-effort unload of any previous version; ignore "not loaded".
  await run(["launchctl", "bootout", `${guiDomain()}/${params.label}`]);
  await runOrThrow(["launchctl", "bootstrap", guiDomain(), path]);
}

/** Boots the agent out (if loaded) and removes its plist. */
export async function uninstallFallbackAgent(label: string): Promise<boolean> {
  const path = fallbackPlistPath(label);
  const existed = existsSync(path);
  await run(["launchctl", "bootout", `${guiDomain()}/${label}`]);
  if (existed) rmSync(path, { force: true });
  return existed;
}

/** Whether launchd currently has the agent loaded. Tolerant of a missing launchctl. */
export async function isFallbackLoaded(label: string): Promise<boolean> {
  try {
    const result = await run(["launchctl", "print", `${guiDomain()}/${label}`]);
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Reads the Hour/Minute programmed into an installed plist, for status. */
export function readPlistLocalTime(label: string): LocalTime | undefined {
  const path = fallbackPlistPath(label);
  if (!existsSync(path)) return undefined;
  const xml = readFileSync(path, "utf8");
  const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml);
  const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml);
  if (hour?.[1] === undefined || minute?.[1] === undefined) return undefined;
  return { hour: Number(hour[1]), minute: Number(minute[1]) };
}
