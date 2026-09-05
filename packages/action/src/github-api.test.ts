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
});
