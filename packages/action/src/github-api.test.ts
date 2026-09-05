import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { makeGitHubApi } from "./github-api.ts";

/**
 * The check-runs API needs a "Checks" permission GitHub does not expose to
 * fine-grained PATs, so a fine-grained runtime token 403s when reading a ref's
 * checks. `getChecksForRef` must swallow that into `readable: false` (mirroring
 * `getRequiredChecks`) instead of throwing and failing the whole issue.
 */
describe("makeGitHubApi.getChecksForRef", () => {
  it("returns readable:false (never throws) when the check-runs read 403s", async () => {
    const notAccessible = Object.assign(
      new Error("Resource not accessible by personal access token"),
      { status: 403 },
    );
    const octokit = {
      paginate: async () => {
        throw notAccessible;
      },
      checks: { listForRef: () => {} },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    } as unknown as Octokit;

    const api = makeGitHubApi(octokit, "owner", "repo", undefined);
    const result = await api.getChecksForRef("deadbeef");

    expect(result).toEqual({ readable: false, checks: [] });
  });

  it("returns readable:true with the normalized checks on a successful read", async () => {
    const octokit = {
      paginate: async () => [
        { name: "ci", status: "completed", conclusion: "success", output: {}, details_url: null },
      ],
      checks: { listForRef: () => {} },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    } as unknown as Octokit;

    const api = makeGitHubApi(octokit, "owner", "repo", undefined);
    const result = await api.getChecksForRef("deadbeef");

    expect(result.readable).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["ci"]);
  });

  it("re-throws a non-permission error (a transient failure still surfaces)", async () => {
    const serverError = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const octokit = {
      paginate: async () => {
        throw serverError;
      },
      checks: { listForRef: () => {} },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    } as unknown as Octokit;

    const api = makeGitHubApi(octokit, "owner", "repo", undefined);
    await expect(api.getChecksForRef("deadbeef")).rejects.toThrow("Internal Server Error");
  });

  it("re-throws a transient rate-limit 403 (must not degrade to readable:false)", async () => {
    const rateLimited = Object.assign(
      new Error("You have exceeded a secondary rate limit"),
      { status: 403 },
    );
    const octokit = {
      paginate: async () => {
        throw rateLimited;
      },
      checks: { listForRef: () => {} },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    } as unknown as Octokit;

    const api = makeGitHubApi(octokit, "owner", "repo", undefined);
    await expect(api.getChecksForRef("deadbeef")).rejects.toThrow("secondary rate limit");
  });

  it("re-throws a 404 wrong-ref (must not degrade to readable:false)", async () => {
    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = {
      paginate: async () => {
        throw notFound;
      },
      checks: { listForRef: () => {} },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    } as unknown as Octokit;

    const api = makeGitHubApi(octokit, "owner", "repo", undefined);
    await expect(api.getChecksForRef("deadbeef")).rejects.toThrow("Not Found");
  });

  it("degrades on the App-token permission-denial variant (integration)", async () => {
    const notAccessible = Object.assign(
      new Error("Resource not accessible by integration"),
      { status: 403 },
    );
    const octokit = {
      paginate: async () => {
        throw notAccessible;
      },
      checks: { listForRef: () => {} },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    } as unknown as Octokit;

    const api = makeGitHubApi(octokit, "owner", "repo", undefined);
    const result = await api.getChecksForRef("deadbeef");

    expect(result).toEqual({ readable: false, checks: [] });
  });
});
