import { generateKeyPairSync } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePushTokenProvider, makeRuntimeOctokit } from "./runtime-octokit.ts";

/** A real 2048-bit RSA key (PKCS#8) so the App JWT is actually signed in-test. */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_ID = 123456;
const INSTALLATION_ID = 7890123;

/**
 * A fake @octokit/request that serves installation tokens with a controllable
 * 1-hour expiry, counting each mint. Only the access-tokens route is exercised
 * (the App JWT is created locally by universal-github-app-jwt, no request).
 */
function fakeMinter(): { request: (route: string) => Promise<unknown>; mints: () => number } {
  let count = 0;
  async function fakeRequest(route: string): Promise<unknown> {
    if (route !== "POST /app/installations/{installation_id}/access_tokens") {
      throw new Error(`unexpected request in test: ${route}`);
    }
    const token = `t${count}`;
    count += 1;
    return {
      status: 201,
      data: {
        token,
        // GitHub installation tokens expire ~1h after minting.
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        permissions: { checks: "read", contents: "write" },
        repository_selection: "all",
      },
    };
  }
  return { request: fakeRequest, mints: () => count };
}

describe("makeRuntimeOctokit", () => {
  it("builds an app-strategy client from the App credential", () => {
    const app = makeRuntimeOctokit({ appId: APP_ID, privateKey, installationId: INSTALLATION_ID });
    // Constructing the App client must not throw and must expose the auth strategy.
    expect(typeof app.auth).toBe("function");
  });
});

describe("makePushTokenProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-mints a fresh installation token across a simulated >1h night", async () => {
    // The proof that the App path survives the 1-hour installation-token expiry
    // without human intervention: the same provider, asked again after the token
    // has aged past its expiry, returns a NEW token via a SECOND mint - exactly
    // what keeps pushes and API calls alive hours into the night.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const minter = fakeMinter();
    const appAuth = createAppAuth({
      appId: APP_ID,
      privateKey,
      installationId: INSTALLATION_ID,
      request: minter.request as never,
    });
    const provider = makePushTokenProvider({ auth: appAuth as never });

    // t=0: first call mints t0.
    expect(await provider()).toBe("t0");
    expect(minter.mints()).toBe(1);

    // A few minutes later the cached token is still fresh - no new mint.
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
    expect(await provider()).toBe("t0");
    expect(minter.mints()).toBe(1);

    // Past the ~1h expiry (the naive single-mint would 401 here). The strategy
    // transparently mints t1 instead.
    vi.setSystemTime(new Date("2026-01-01T01:05:00Z"));
    expect(await provider()).toBe("t1");
    expect(minter.mints()).toBe(2);

    // And keeps refreshing on the next hour's boundary.
    vi.setSystemTime(new Date("2026-01-01T02:10:00Z"));
    expect(await provider()).toBe("t2");
    expect(minter.mints()).toBe(3);
  });

  it("propagates a refresh failure instead of pushing unauthenticated", async () => {
    const provider = makePushTokenProvider({
      auth: () => Promise.reject(new Error("mint failed")),
    });
    await expect(provider()).rejects.toThrow(/mint failed/);
  });
});
