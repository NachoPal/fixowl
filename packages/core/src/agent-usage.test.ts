import { describe, expect, it } from "vitest";
import {
  CLAUDE_USAGE_URL,
  getUsageReader,
  parseClaudeUsage,
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

  it("reads the non-billing usage endpoint with the bearer token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const reader = getUsageReader("claude");
    const result = await reader.read(
      probe({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }, async (url, headers) => {
        calls.push({ url, headers });
        return { five_hour: { utilization: 0.9, resets_at: 1 } };
      }),
    );
    expect(result.snapshot?.usedPercent).toBeCloseTo(90);
    expect(result.reason).toBeUndefined();
    expect(calls[0]?.url).toBe(CLAUDE_USAGE_URL);
    expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
    expect(calls[0]?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("abstains with the concrete cause when the fetch rejects (non-2xx surfaces as a throw)", async () => {
    const reader = getUsageReader("claude");
    const result = await reader.read(
      probe({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }, async () => {
        // The injected edge throws `HTTP <status>` on a non-2xx.
        throw new Error("HTTP 401");
      }),
    );
    expect(result.snapshot).toBeUndefined();
    expect(result.reason).toBe("usage read failed: HTTP 401");
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
