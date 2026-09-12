import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  ensureLabels,
  PICKUP_LABEL_META,
  resolveActionRef,
  SELECTOR_LABEL_META,
} from "./repo-provisioning.ts";

interface CreatedLabel {
  name: string;
  color: string;
  description: string;
}

/**
 * A fake Octokit whose issues endpoints record created labels. `existing` names
 * report present (getLabel resolves); everything else 404s so createLabel runs.
 */
function fakeOctokit(existing: readonly string[] = []): {
  octokit: Octokit;
  created: CreatedLabel[];
} {
  const created: CreatedLabel[] = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const octokit = {
    rest: {
      issues: {
        getLabel: vi.fn(async ({ name }: { name: string }) => {
          if (existing.includes(name)) return { data: {} };
          throw notFound;
        }),
        createLabel: vi.fn(async (label: CreatedLabel) => {
          created.push(label);
          return { data: {} };
        }),
      },
    },
  } as unknown as Octokit;
  return { octokit, created };
}

const ref = { owner: "acme", repo: "widgets" };

describe("ensureLabels", () => {
  it("creates missing labels with the pickup metadata by default", async () => {
    const { octokit, created } = fakeOctokit();

    const names = await ensureLabels(octokit, ref, ["overnight"]);

    expect(names).toEqual(["overnight"]);
    expect(created).toEqual([{ ...ref, name: "overnight", ...PICKUP_LABEL_META }]);
  });

  it("stamps selector labels with the selector metadata, not the pickup description", async () => {
    const { octokit, created } = fakeOctokit();

    await ensureLabels(octokit, ref, ["heavy"], SELECTOR_LABEL_META);

    expect(created).toHaveLength(1);
    expect(created[0]?.description).toBe(SELECTOR_LABEL_META.description);
    expect(created[0]?.description).not.toBe(PICKUP_LABEL_META.description);
    expect(created[0]?.color).toBe(SELECTOR_LABEL_META.color);
  });

  it("is idempotent: existing labels are left untouched", async () => {
    const { octokit, created } = fakeOctokit(["heavy"]);

    const names = await ensureLabels(octokit, ref, ["heavy", "quick"], SELECTOR_LABEL_META);

    expect(names).toEqual(["quick"]);
    expect(created.map((label) => label.name)).toEqual(["quick"]);
  });
});

const ACTION_REPO = "NachoPal/fixowl";

/**
 * A fake Octokit whose `repos.getCommit` resolves a fixed map of ref -> SHA and
 * 404s for anything else, so `resolveActionRef` sees a tag/HEAD as present or
 * missing exactly as the map says. Records the refs it was asked to resolve.
 */
function fakeCommitOctokit(shaByRef: Record<string, string>): {
  octokit: Octokit;
  refsAsked: string[];
} {
  const refsAsked: string[] = [];
  const notFound = Object.assign(new Error("Not Found"), { status: 404 });
  const octokit = {
    rest: {
      repos: {
        getCommit: vi.fn(async ({ ref: commitRef }: { ref: string }) => {
          refsAsked.push(commitRef);
          const sha = shaByRef[commitRef];
          if (sha === undefined) throw notFound;
          return { data: { sha } };
        }),
      },
    },
  } as unknown as Octokit;
  return { octokit, refsAsked };
}

describe("resolveActionRef", () => {
  it("default (cli-release): pins the CLI version's tag SHA with a version comment", async () => {
    const { octokit, refsAsked } = fakeCommitOctokit({ "v0.2.0-rc.10": "tagsha" });

    const resolved = await resolveActionRef(octokit, ACTION_REPO, {
      kind: "cli-release",
      cliVersion: "0.2.0-rc.10",
    });

    expect(resolved.ref).toBe(`${ACTION_REPO}@tagsha`);
    expect(resolved.comment).toBe("v0.2.0-rc.10");
    expect(refsAsked).toEqual(["v0.2.0-rc.10"]);
  });

  it("typed tag: resolves it online to its SHA", async () => {
    const { octokit } = fakeCommitOctokit({ "v0.2.0-rc.9": "rc9sha" });

    const resolved = await resolveActionRef(octokit, ACTION_REPO, {
      kind: "tag",
      tag: "v0.2.0-rc.9",
    });

    expect(resolved.ref).toBe(`${ACTION_REPO}@rc9sha`);
    expect(resolved.comment).toBe("v0.2.0-rc.9");
  });

  it("typed tag not found: hard-fails with an actionable error (no silent fallback)", async () => {
    // HEAD would resolve, proving the failure is a deliberate refusal, not an
    // inability to reach the repo.
    const { octokit } = fakeCommitOctokit({ HEAD: "headsha" });

    await expect(
      resolveActionRef(octokit, ACTION_REPO, { kind: "tag", tag: "v9.9.9" }),
    ).rejects.toThrow(/tag "v9\.9\.9" was not found/);
  });

  it("main: pins the moving @main ref, never a frozen SHA", async () => {
    const { octokit, refsAsked } = fakeCommitOctokit({ HEAD: "headsha" });

    const resolved = await resolveActionRef(octokit, ACTION_REPO, { kind: "main" });

    expect(resolved.ref).toBe(`${ACTION_REPO}@main`);
    expect(resolved.comment).toBe("main (tracks latest)");
    // A moving ref needs no online resolution at all.
    expect(refsAsked).toEqual([]);
  });

  it("dev build with no matching tag: default falls back to main HEAD with a note", async () => {
    const { octokit, refsAsked } = fakeCommitOctokit({ HEAD: "headsha" });

    const resolved = await resolveActionRef(octokit, ACTION_REPO, {
      kind: "cli-release",
      cliVersion: "0.2.0",
    });

    expect(resolved.ref).toBe(`${ACTION_REPO}@headsha`);
    expect(resolved.comment).toMatch(/no v0\.2\.0 tag; dev\/source build/);
    // It tries the tag first, then falls back to HEAD.
    expect(refsAsked).toEqual(["v0.2.0", "HEAD"]);
  });
});
