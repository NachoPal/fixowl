import { describe, expect, it } from "vitest";
import {
  CLAUDE_USAGE_URL,
  describeUsageHttpError,
  getUsageReader,
  parseClaudeUsage,
  USAGE_ERROR_BODY_MAX,
  type UsageProbe,
} from "./agent-usage.ts";

describe("parseClaudeUsage", () => {
  it("normalizes a 0..1 utilization fraction to a percent and picks the max window", () => {
    const snapshot = parseClaudeUsage({
      five_hour: { utilization: 0.4, resets_at: 1_700_000_000 },
      seven_day: { utilization: 0.72, resets_at: 1_700_600_000 },
    });
    expect(snapshot).toBeDefined();
    expect(snapshot?.windows.five_hour?.usedPercent).toBeCloseTo(40);
    expect(snapshot?.windows.seven_day?.usedPercent).toBeCloseTo(72);
    expect(snapshot?.usedPercent).toBeCloseTo(72);
    expect(snapshot?.limiting).toBe("seven_day");
  });

  it("accepts an already-percent used_percentage and an ISO resets_at", () => {
    const snapshot = parseClaudeUsage({
      five_hour: { used_percentage: 88, resets_at: "2026-01-01T00:00:00Z" },
    });
    expect(snapshot?.usedPercent).toBe(88);
    expect(snapshot?.windows.five_hour?.resetsAt).toBe(
      Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
    );
  });

  it("reads windows nested under rate_limits", () => {
    const snapshot = parseClaudeUsage({
      rate_limits: { five_hour: { utilization: 0.5, resets_at: 10 } },
    });
    expect(snapshot?.usedPercent).toBeCloseTo(50);
    expect(snapshot?.limiting).toBe("five_hour");
  });

  it("returns undefined for a shape with no parseable window", () => {
    expect(parseClaudeUsage(null)).toBeUndefined();
    expect(parseClaudeUsage("nope")).toBeUndefined();
    expect(parseClaudeUsage({})).toBeUndefined();
    expect(parseClaudeUsage({ five_hour: { something_else: 1 } })).toBeUndefined();
  });
});

function probe(
  env: Record<string, string | undefined>,
  fetchJson: UsageProbe["fetchJson"],
): UsageProbe {
  return { env, fetchJson };
}

describe("claude usage reader", () => {
  it("abstains with a missing-token reason when no OAuth token is present", async () => {
    let called = false;
    const reader = getUsageReader("claude");
    const result = await reader.read(
      probe({}, async () => {
        called = true;
        return {};
      }),
    );
    expect(result.snapshot).toBeUndefined();
    expect(result.reason).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    // No token means no network read - abstain before touching the edge.
    expect(called).toBe(false);
  });

  it("sends exactly the required header set to the usage endpoint", async () => {
    // Locks the working request shape so a refactor can't silently drop or add a
    // header. The 403 this task fixed was NOT a header problem (the token's OAuth
    // scope is; CLAUDE_CODE_OAUTH_TOKEN is inference-only and cannot read the
    // profile-scoped usage window) - but this guard keeps the known-good shape
    // pinned so the header set never becomes a suspect again.
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const reader = getUsageReader("claude");
    const result = await reader.read(
      probe({ CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token" }, async (url, headers) => {
        calls.push({ url, headers });
        return { five_hour: { utilization: 0.9, resets_at: 1 } };
      }),
    );
    expect(result.snapshot?.usedPercent).toBeCloseTo(90);
    expect(result.reason).toBeUndefined();
    expect(calls[0]?.url).toBe(CLAUDE_USAGE_URL);
    // Exact set - no more, no less - not just a superset check.
    expect(calls[0]?.headers).toEqual({
      Authorization: "Bearer test-oauth-token",
      "anthropic-beta": "oauth-2025-04-20",
    });
  });

  it("abstains with the concrete cause when the fetch rejects (non-2xx surfaces as a throw)", async () => {
    const reader = getUsageReader("claude");
    const result = await reader.read(
      probe({ CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token" }, async () => {
        // The injected edge throws `HTTP <status>` on a non-2xx.
        throw new Error("HTTP 401");
      }),
    );
    expect(result.snapshot).toBeUndefined();
    expect(result.reason).toBe("usage read failed: HTTP 401");
  });

  it("surfaces the endpoint's non-2xx body in the abstain reason (self-diagnosing 403)", async () => {
    // The edge folds a bounded body slice into the thrown message (see
    // describeUsageHttpError); the reader must propagate it verbatim so the real
    // cause - here the actual /api/oauth/usage 403 - reaches the run log instead of
    // a bare "HTTP 403". This is the guardrail that makes the next endpoint change
    // instantly diagnosable.
    const reader = getUsageReader("claude");
    const edgeDetail = describeUsageHttpError(
      403,
      '{"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile","error_code":"oauth_scope_insufficient"}}',
    );
    const result = await reader.read(
      probe({ CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token" }, async () => {
        throw new Error(edgeDetail);
      }),
    );
    expect(result.snapshot).toBeUndefined();
    expect(result.reason).toBe(`usage read failed: ${edgeDetail}`);
    expect(result.reason).toContain("user:profile");
    expect(result.reason).toContain("oauth_scope_insufficient");
  });

  it("abstains with a shape reason on a 200 whose body no longer matches", async () => {
    const reader = getUsageReader("claude");
    const result = await reader.read(
      probe({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }, async () => ({ unexpected: true })),
    );
    expect(result.snapshot).toBeUndefined();
    expect(result.reason).toBe("usage read: unexpected response shape");
  });
});

describe("describeUsageHttpError", () => {
  it("folds a single-line, whitespace-collapsed body slice into the detail", () => {
    const detail = describeUsageHttpError(
      403,
      '{"error":{"message":"OAuth token does not meet scope\n  requirement user:profile"}}',
    );
    expect(detail.startsWith("HTTP 403: ")).toBe(true);
    expect(detail).toContain("scope requirement user:profile");
    // No raw newlines/tabs leak into the log line.
    expect(detail).not.toMatch(/[\n\t]/);
    expect(detail).not.toContain("  ");
  });

  it("returns the bare status when the body is empty or whitespace", () => {
    expect(describeUsageHttpError(500, "")).toBe("HTTP 500");
    expect(describeUsageHttpError(429, "   \n\t ")).toBe("HTTP 429");
  });

  it("caps the body slice so a large body can never spill into the log", () => {
    const detail = describeUsageHttpError(403, "x".repeat(5000));
    // "HTTP 403: " prefix plus at most USAGE_ERROR_BODY_MAX body chars.
    expect(detail.length).toBe("HTTP 403: ".length + USAGE_ERROR_BODY_MAX);
  });
});

describe("getUsageReader (model-agnostic)", () => {
  it("gives agents without an observable window a reader that always abstains", async () => {
    for (const name of ["codex", "script", "unknown-agent"]) {
      const reader = getUsageReader(name);
      const result = await reader.read({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "x" },
        fetchJson: async () => ({ five_hour: { utilization: 0.99 } }),
      });
      expect(result.snapshot).toBeUndefined();
      expect(result.reason).toBeDefined();
    }
  });
});
