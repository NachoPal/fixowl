/**
 * Reading a coding agent's current subscription/session usage, per-provider and
 * out-of-band on the host (never inside a container). This backs the usage-budget
 * stop condition (issue #21): the host asks the agent's provider "how much of the
 * rolling window is spent?" so the night can stand down before it exhausts the
 * subscription.
 *
 * The abstraction is model-agnostic in the spirit of `agent-adapters.ts`: the run
 * loop asks `getUsageReader(agentName)` and never mentions Claude. An agent whose
 * usage is not observable (script, or claude under API-key auth, which has no
 * OAuth token to read the window with) returns a reader that yields
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
 * The outcome of one usage read. Exactly one of `snapshot`/`reason` is set:
 * a successful read carries the `snapshot`; any abstain carries a concise,
 * log-worthy `reason` (missing token / non-2xx endpoint / unexpected shape) so
 * the caller can surface *why* the usage budget went unobserved instead of
 * emitting a bare "unobservable" warning. The read never throws for a transient
 * failure - it abstains with a `reason` and the run falls through to the
 * remaining conditions (tokens + wall-clock), preserving the fail-open contract.
 */
export interface UsageReadResult {
  snapshot?: UsageSnapshot;
  /** Set iff `snapshot` is absent: a short reason the caller logs at warn level. */
  reason?: string;
}

/**
 * Per-adapter usage reader. Abstains (a `UsageReadResult` with a `reason` and no
 * `snapshot`) when usage is not observable for this agent/auth mode or the read
 * fails; the run loop then skips the usage stop-condition and logs the reason.
 * Never throws for a transient read failure.
 */
export interface UsageReader {
  read(probe: UsageProbe): Promise<UsageReadResult>;
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
  async read(probe: UsageProbe): Promise<UsageReadResult> {
    const token = probe.env[CLAUDE_TOKEN_ENV];
    // No OAuth token on the host (the var never reached the action's env, or the
    // agent is on API-key auth) means no observable rolling window. The run loop
    // only invokes this reader on the subscription path, so a missing token here
    // is a genuine wiring gap worth surfacing, not a quiet structural opt-out.
    if (token === undefined || token === "") {
      return { reason: `no ${CLAUDE_TOKEN_ENV} on host` };
    }
    let raw: unknown;
    try {
      raw = await probe.fetchJson(CLAUDE_USAGE_URL, {
        Authorization: `Bearer ${token}`,
        // The OAuth flow beta header Claude Code sends for this endpoint.
        "anthropic-beta": "oauth-2025-04-20",
      });
    } catch (error) {
      // Advisory infrastructure: a transient read failure (non-2xx surfaced by
      // the injected edge as a throw, or a transport error) must never abort the
      // night. Abstain with the concrete cause so the next run is diagnosable,
      // and let the selection cap + wall-clock carry the run.
      const detail = error instanceof Error ? error.message : String(error);
      return { reason: `usage read failed: ${detail}` };
    }
    const snapshot = parseClaudeUsage(raw);
    if (snapshot === undefined) {
      // A 200 whose body no longer matches the expected window shape (a provider
      // field rename) - surface it distinctly from a network/HTTP failure.
      return { reason: "usage read: unexpected response shape" };
    }
    return { snapshot };
  },
};

/** A reader for agents whose usage is not observable; always abstains. */
const noUsageReader: UsageReader = {
  async read(): Promise<UsageReadResult> {
    return { reason: "no observable usage window for this agent" };
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
