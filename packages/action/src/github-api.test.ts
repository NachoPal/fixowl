import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { makeGitHubApi, reduceTriageNode } from "./github-api.ts";

/**
 * The check-runs API needs the App's "Checks" permission, so an installation
 * missing Checks: read 403s when reading a ref's checks ("Resource not
 * accessible by integration"; GitHub words the same denial "by personal access
 * token" for a user token, and both are exercised here). `getChecksForRef` must
 * swallow that into `readable: false` (mirroring `getRequiredChecks`) instead
 * of throwing and failing the whole issue.
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
    const rateLimited = Object.assign(new Error("You have exceeded a secondary rate limit"), {
      status: 403,
    });
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
    const notAccessible = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
    });
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

/**
 * `reduceTriageNode` turns one aliased issue's raw GraphQL triage node into the
 * high-precision Layer A signals. The timeline node union is discriminated by
 * field presence (no __typename), so these fixtures mirror exactly the fields
 * each inline fragment populates.
 */
describe("reduceTriageNode", () => {
  const REPO = "o/r";

  it("surfaces a merged PR formally linked by a closing keyword (closedByPullRequestsReferences)", () => {
    const node = {
      number: 1,
      closedByPullRequestsReferences: { nodes: [{ number: 51, url: "u/51", merged: true }] },
      timelineItems: { nodes: [] },
    };
    expect(reduceTriageNode(node, 1, REPO).fixedByMergedPr).toEqual({ number: 51, url: "u/51" });
  });

  it("ignores an unmerged closing reference", () => {
    const node = {
      number: 1,
      closedByPullRequestsReferences: { nodes: [{ number: 51, url: "u/51", merged: false }] },
      timelineItems: { nodes: [] },
    };
    expect(reduceTriageNode(node, 1, REPO).fixedByMergedPr).toBeUndefined();
  });

  it("uses a merged, closing-keyword cross-reference in this repo as the fallback", () => {
    const node = {
      number: 1,
      closedByPullRequestsReferences: { nodes: [] },
      timelineItems: {
        nodes: [
          {
            willCloseTarget: true,
            source: { number: 7, url: "u/7", merged: true, repository: { nameWithOwner: REPO } },
          },
        ],
      },
    };
    expect(reduceTriageNode(node, 1, REPO).fixedByMergedPr).toEqual({ number: 7, url: "u/7" });
  });

  it("does NOT surface a bare (no closing keyword) merged cross-reference - the #136 case", () => {
    const node = {
      number: 136,
      closedByPullRequestsReferences: { nodes: [] },
      timelineItems: {
        nodes: [
          {
            willCloseTarget: false,
            source: {
              number: 137,
              url: "u/137",
              merged: true,
              repository: { nameWithOwner: REPO },
            },
          },
        ],
      },
    };
    expect(reduceTriageNode(node, 136, REPO).fixedByMergedPr).toBeUndefined();
  });

  it("ignores a closing cross-reference from a merged PR in another repo", () => {
    const node = {
      number: 1,
      closedByPullRequestsReferences: { nodes: [] },
      timelineItems: {
        nodes: [
          {
            willCloseTarget: true,
            source: {
              number: 7,
              url: "u/7",
              merged: true,
              repository: { nameWithOwner: "other/repo" },
            },
          },
        ],
      },
    };
    expect(reduceTriageNode(node, 1, REPO).fixedByMergedPr).toBeUndefined();
  });

  it("surfaces the canonical of a marked duplicate", () => {
    const node = {
      number: 1,
      closedByPullRequestsReferences: { nodes: [] },
      timelineItems: { nodes: [{ canonical: { number: 9, url: "u/9" } }] },
    };
    expect(reduceTriageNode(node, 1, REPO).duplicateOf).toEqual({ number: 9, url: "u/9" });
  });

  it("clears the duplicate when a later unmark undoes the mark", () => {
    const node = {
      number: 1,
      closedByPullRequestsReferences: { nodes: [] },
      timelineItems: {
        nodes: [{ canonical: { number: 9, url: "u/9" } }, { unmarkedAt: "2026-09-10T00:00:00Z" }],
      },
    };
    expect(reduceTriageNode(node, 1, REPO).duplicateOf).toBeUndefined();
  });

  it("returns empty signals for a null node", () => {
    expect(reduceTriageNode(null, 1, REPO)).toEqual({ number: 1 });
  });
});
