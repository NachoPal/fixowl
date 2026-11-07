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
 * (wired to `fetch` at the edge, faked in tests), and the retry backoff's wait is
 * the injected `UsageProbe.sleep`.
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
 * single injected I/O edge; it must reject on a non-2xx or transport error
 * (ideally with a {@link UsageHttpError} so the retry can see the status and any
 * `Retry-After`). `sleep` is the second, retry-only edge - injected so tests
 * exercise the backoff without real delays; it defaults to a real timer.
 */
export interface UsageProbe {
  env: Record<string, string | undefined>;
  fetchJson(url: string, headers: Record<string, string>): Promise<unknown>;
  sleep?(ms: number): Promise<void>;
}

/**
 * The outcome of one usage read. Exactly one of `snapshot`/`reason` is set:
 * a successful read carries the `snapshot`; any abstain carries a concise,
 * log-worthy `reason` (missing token / non-2xx endpoint / unexpected shape) so
 * the caller can surface *why* the usage budget went unobserved instead of
 * emitting a bare "unobservable" warning. The read never throws for a transient
 * failure - it abstains with a `reason` and the run falls through to the
 * remaining conditions (count + wall-clock), preserving the fail-open contract.
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
 * Max chars of a non-2xx response body echoed into a usage-read error. Bounded so
 * a future endpoint change never spills an unbounded body into the run log.
 */
export const USAGE_ERROR_BODY_MAX = 300;

/**
 * Backoff delays before each retry of a usage read, so a transient 429 does not
 * immediately disable the usage budget (issue #114). Length == retry count, so
 * one read makes at most `USAGE_RETRY_DELAYS_MS.length + 1` requests. Kept short
 * and bounded: the read sits on the critical path of a budget gate, and the
 * fallback (count + wall-clock) is always there, so waiting long is never worth
 * it. A `Retry-After` on the response wins over these (capped, see below).
 */
export const USAGE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** Upper bound honored from a `Retry-After`; a longer hint falls back to the backoff. */
export const USAGE_RETRY_AFTER_MAX_MS = 15_000;

/**
 * A non-2xx from the usage endpoint, carrying the structured bits the retry
 * needs: the `status` (is this worth retrying?) and the parsed `Retry-After`.
 * The edge (`fetchJson`) throws it; the reader is still tolerant of a plain
 * `Error` whose message starts with `HTTP <status>` (see `usageErrorStatus`), so
 * an edge - or a test fake - that only throws a message keeps working.
 */
export class UsageHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "UsageHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse an HTTP `Retry-After` value (delta-seconds or an HTTP-date) to a delay in
 * ms, clamped to [0, {@link USAGE_RETRY_AFTER_MAX_MS}]. Returns `undefined` for a
 * missing/unparseable value or a hint longer than the cap, so the caller falls
 * back to its own backoff rather than stalling the night on a provider hint.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  if (!Number.isFinite(ms) || ms > USAGE_RETRY_AFTER_MAX_MS) return undefined;
  return Math.max(0, ms);
}

/**
 * Whether a usage-read failure with this status is worth retrying. Throttling
 * (429, the common case for a loaded subscription - the usage endpoint shares the
 * subscription's rate-limit state), a request timeout, and server errors are
 * transient; an auth/scope error (401/403) or any other 4xx is not - retrying it
 * would only delay the fall-through to count + wall-clock.
 */
export function isRetryableUsageStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * The HTTP status behind a usage-read rejection, when there is one. Prefers the
 * structured {@link UsageHttpError}; otherwise reads the leading `HTTP <status>`
 * that {@link describeUsageHttpError} puts at the front of the message. Returns
 * `undefined` for a transport-level error (DNS/socket), which is retryable.
 */
function usageErrorStatus(error: unknown): number | undefined {
  if (error instanceof UsageHttpError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  const match = /^HTTP (\d{3})\b/.exec(message);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The abstain reason for a failed usage read. A single-attempt failure keeps the
 * original `usage read failed: <detail>` wording; once retries happened the count
 * is stated so the operator can tell a one-off blip from a persistent outage, and
 * a 429 is called out by name because it is the expected failure for a loaded
 * subscription rather than a misconfiguration.
 */
export function describeUsageAbstain(
  detail: string,
  attempts: number,
  status: number | undefined,
): string {
  const prefix = status === 429 ? "usage read rate-limited by the provider" : "usage read failed";
  const tries = attempts > 1 ? ` after ${attempts} attempts` : "";
  return `${prefix}${tries}: ${detail}`;
}

/**
 * Compose the detail string for a non-2xx usage read, folding a bounded slice of
 * the response body into the message so the failure is self-diagnosing rather than
 * a bare "HTTP 403". This is the guardrail that turned a multi-run mystery into a
 * one-look answer: the `/api/oauth/usage` 403 body states the exact cause (e.g.
 * "OAuth token does not meet scope requirement user:profile"), which the old
 * `HTTP <status>`-only message threw away.
 *
 * Secret-safety: the usage endpoint's error body carries no credentials, and the
 * caller (the `fetchJson` edge) never passes request headers here, so nothing
 * secret can reach the log. Whitespace is collapsed to keep the reason single-line
 * and the slice is length-capped at {@link USAGE_ERROR_BODY_MAX}.
 */
export function describeUsageHttpError(status: number, body: string): string {
  const base = `HTTP ${status}`;
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (trimmed === "") return base;
  return `${base}: ${trimmed.slice(0, USAGE_ERROR_BODY_MAX)}`;
}

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

/** Real-timer sleep for the retry backoff; tests inject `UsageProbe.sleep`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const sleep = probe.sleep ?? defaultSleep;
    let raw: unknown;
    // Bounded retry (issue #114): the usage endpoint shares the subscription's
    // rate-limit state, so under exactly the load that makes the budget matter it
    // can answer 429. A couple of short retries (honoring `Retry-After`) keep a
    // transient throttle from silently disabling the budget for the whole night.
    for (let attempt = 1; ; attempt++) {
      try {
        raw = await probe.fetchJson(CLAUDE_USAGE_URL, {
          Authorization: `Bearer ${token}`,
          // The OAuth flow beta header Claude Code sends for this endpoint.
          "anthropic-beta": "oauth-2025-04-20",
        });
        break;
      } catch (error) {
        // Advisory infrastructure: a transient read failure (non-2xx surfaced by
        // the injected edge as a throw, or a transport error) must never abort the
        // night. Abstain with the concrete cause so the next run is diagnosable,
        // and let count + wall-clock carry the run.
        const detail = error instanceof Error ? error.message : String(error);
        const status = usageErrorStatus(error);
        // A transport error has no status and is always worth one more try.
        const retryable = status === undefined || isRetryableUsageStatus(status);
        const backoff = USAGE_RETRY_DELAYS_MS[attempt - 1];
        if (!retryable || backoff === undefined) {
          return { reason: describeUsageAbstain(detail, attempt, status) };
        }
        const hinted = error instanceof UsageHttpError ? error.retryAfterMs : undefined;
        await sleep(hinted ?? backoff);
      }
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
