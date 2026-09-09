import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { ensureLabels, PICKUP_LABEL_META, SELECTOR_LABEL_META } from "./repo-provisioning.ts";

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
