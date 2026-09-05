/**
 * Reading a coding agent's current subscription/session usage, per-provider and
 * out-of-band on the host (never inside a container). This backs the usage-budget
 * stop condition (issue #21): the host asks the agent's provider "how much of the
 * rolling window is spent?" so the night can stand down before it exhausts the
 * subscription.
 *
 * The abstraction is model-agnostic in the spirit of `agent-adapters.ts`: the run
 * loop asks `getUsageReader(agentName)` and never mentions Claude. An agent whose
 * usage is not observable (aider/script/API-key auth) returns a reader that yields
 * `undefined`, which opts that run out of the usage condition automatically -
 * adding a new agent's reader needs no run-loop change.
 *
 * Pure/deps split follows fixowl convention: the URL shape and response parsing
 * are pure here; the actual network call is the injected `UsageProbe.fetchJson`
 * (wired to `fetch` at the edge, faked in tests).
 */

/** A normalized reading of one agent's current usage windows. */
export interface UsageSnapshot {
  /** Highest utilization across the agent's windows, as a percent 0..100. */
  usedPercent: number;
  /** Per-window detail, provider-defined keys (e.g. "five_hour", "seven_day"). */
  windows: Record<string, { usedPercent: number; resetsAt: number /* epoch seconds */ }>;
  /** Which window drove `usedPercent` (for logging / the night summary). */
  limiting: string;
}

/**
 * How the host reaches one agent's usage. The reader picks whatever token it
 * needs out of `env` (the already-resolved agent env allowlist), so the run loop
 * never has to know which credential a given provider uses. `fetchJson` is the
 * single injected I/O edge; it must reject on a non-2xx or transport error.
 */
export interface UsageProbe {
  env: Record<string, string | undefined>;
  fetchJson(url: string, headers: Record<string, string>): Promise<unknown>;
}

/**
 * Per-adapter usage reader. Returns `undefined` when usage is not observable for
 * this agent/auth mode (the run loop then skips the usage stop-condition). Never
 * throws for a transient read failure: it returns `undefined` and lets the caller
 * log once and fall through to the remaining conditions (count + wall-clock).
 */
export interface UsageReader {
  read(probe: UsageProbe): Promise<UsageSnapshot | undefined>;
}

/** The non-billing OAuth usage endpoint Claude Code itself seeds from. */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1";

/** Env var whose OAuth token authorizes the Claude usage read (already on the host). */
const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Normalize the Claude usage payload to a `UsageSnapshot`. Defensive by design so
 * a provider-side field rename is contained here, never in the run loop:
 * - windows are read from `five_hour`/`seven_day` (top-level) or under `rate_limits`;
 * - a window's percent comes from `used_percentage` (already 0..100) or, failing
 *   that, `utilization` (a 0..1 fraction, ×100);
 * - `resets_at` accepts an epoch number or an ISO string, normalized to epoch seconds.
 *
 * Returns `undefined` when nothing parseable is present (an unexpected shape must
 * abstain, not crash the night).
 */
export function parseClaudeUsage(raw: unknown): UsageSnapshot | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  const rateLimits =
    root.rate_limits !== null && typeof root.rate_limits === "object"
      ? (root.rate_limits as Record<string, unknown>)
      : undefined;

  const windows: UsageSnapshot["windows"] = {};
  for (const key of ["five_hour", "seven_day"]) {
    const window = pickWindow(root[key]) ?? (rateLimits ? pickWindow(rateLimits[key]) : undefined);
    if (window !== undefined) windows[key] = window;
  }

  const names = Object.keys(windows);
  if (names.length === 0) return undefined;
  let limiting = names[0] as string;
  for (const name of names) {
    if ((windows[name]?.usedPercent ?? 0) > (windows[limiting]?.usedPercent ?? 0)) limiting = name;
  }
  return { usedPercent: windows[limiting]?.usedPercent ?? 0, windows, limiting };
}

function pickWindow(value: unknown): { usedPercent: number; resetsAt: number } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usedPercent = readPercent(record);
  if (usedPercent === undefined) return undefined;
  return { usedPercent, resetsAt: readResetsAt(record.resets_at) };
}

function readPercent(record: Record<string, unknown>): number | undefined {
  if (typeof record.used_percentage === "number" && Number.isFinite(record.used_percentage)) {
    return record.used_percentage;
  }
  if (typeof record.utilization === "number" && Number.isFinite(record.utilization)) {
    return record.utilization * 100;
  }
  return undefined;
}

function readResetsAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return 0;
}

const claudeUsageReader: UsageReader = {
  async read(probe: UsageProbe): Promise<UsageSnapshot | undefined> {
    const token = probe.env[CLAUDE_TOKEN_ENV];
    // No OAuth token (API-key auth, or the var is absent) means no observable
    // rolling window: abstain rather than guessing.
    if (token === undefined || token === "") return undefined;
    try {
      const raw = await probe.fetchJson(CLAUDE_USAGE_URL, {
        Authorization: `Bearer ${token}`,
        // The OAuth flow beta header Claude Code sends for this endpoint.
        "anthropic-beta": "oauth-2025-04-20",
      });
      return parseClaudeUsage(raw);
    } catch {
      // Advisory infrastructure: a transient read failure must never abort the
      // night; abstain and let count + wall-clock carry the run.
      return undefined;
    }
  },
};

/** A reader for agents whose usage is not observable; always abstains. */
const noUsageReader: UsageReader = {
  async read(): Promise<UsageSnapshot | undefined> {
    return undefined;
  },
};

const USAGE_READERS: Record<string, UsageReader> = { claude: claudeUsageReader };

/**
 * The usage reader for `agentName`. Unknown agents (and those with no observable
 * window) get `noUsageReader`, so the usage condition simply opts out for them.
 */
export function getUsageReader(agentName: string): UsageReader {
  return USAGE_READERS[agentName] ?? noUsageReader;
}
