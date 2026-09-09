import { FIXOWL_DEFAULT_GIT_IDENTITY } from "@fixowl/core";
import { describe, expect, it, vi } from "vitest";
import { type AppIdentityOctokit, resolveAppBotIdentity } from "./app-identity.ts";
import type { Logger } from "./deps.ts";

function fakeLog(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const log: Logger = {
    info: () => {},
    warn: (m) => warnings.push(m),
    error: () => {},
  };
  return { log, warnings };
}

function octokit(overrides: {
  slug?: string | null;
  id?: number | undefined;
  appError?: Error;
  userError?: Error;
}): AppIdentityOctokit {
  return {
    apps: {
      getAuthenticated: async () => {
        if (overrides.appError !== undefined) throw overrides.appError;
        return { data: { slug: overrides.slug } };
      },
    },
    users: {
      getByUsername: async () => {
        if (overrides.userError !== undefined) throw overrides.userError;
        return { data: { id: overrides.id as number } };
      },
    },
  };
}

describe("resolveAppBotIdentity", () => {
  it("resolves the canonical App bot no-reply identity from slug + numeric id", async () => {
    const { log, warnings } = fakeLog();
    const identity = await resolveAppBotIdentity(octokit({ slug: "fixowl-app", id: 987654 }), log);
    expect(identity).toEqual({
      name: "fixowl-app[bot]",
      email: "987654+fixowl-app[bot]@users.noreply.github.com",
    });
    expect(warnings).toHaveLength(0);
  });

  it("queries the bot login <slug>[bot] for the numeric id", async () => {
    const getByUsername = vi.fn(async () => ({ data: { id: 42 } }));
    const client: AppIdentityOctokit = {
      apps: { getAuthenticated: async () => ({ data: { slug: "acme-bot" } }) },
      users: { getByUsername },
    };
    await resolveAppBotIdentity(client, fakeLog().log);
    expect(getByUsername).toHaveBeenCalledWith({ username: "acme-bot[bot]" });
  });

  it("warns and falls back when GET /app returns no slug", async () => {
    const { log, warnings } = fakeLog();
    const identity = await resolveAppBotIdentity(octokit({ slug: null, id: 1 }), log);
    expect(identity).toEqual(FIXOWL_DEFAULT_GIT_IDENTITY);
    expect(warnings[0]).toContain("could not resolve");
  });

  it("warns and falls back when the app read fails (never aborts the night)", async () => {
    const { log, warnings } = fakeLog();
    const identity = await resolveAppBotIdentity(
      octokit({ appError: new Error("network down") }),
      log,
    );
    expect(identity).toEqual(FIXOWL_DEFAULT_GIT_IDENTITY);
    expect(warnings[0]).toContain("network down");
  });

  it("warns and falls back when the bot user has no numeric id", async () => {
    const { log, warnings } = fakeLog();
    const identity = await resolveAppBotIdentity(octokit({ slug: "x", id: undefined }), log);
    expect(identity).toEqual(FIXOWL_DEFAULT_GIT_IDENTITY);
    expect(warnings).toHaveLength(1);
  });
});
