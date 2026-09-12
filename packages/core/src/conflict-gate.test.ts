import { describe, expect, it } from "vitest";
import { classifyMergeability } from "./conflict-gate.ts";

describe("classifyMergeability", () => {
  it("rebases only on a dirty (conflicting) PR", () => {
    expect(classifyMergeability(false, "dirty")).toBe("rebase");
  });

  it("rebases a conflicted draft PR whose dirty state is shadowed by draft", () => {
    // A fixowl PR is a draft while the gate runs, and GitHub can report
    // mergeable_state "draft" instead of "dirty"; mergeable === false is then
    // the reliable conflict signal.
    expect(classifyMergeability(false, "draft")).toBe("rebase");
  });

  it("proceeds on a clean PR", () => {
    expect(classifyMergeability(true, "clean")).toBe("proceed");
  });

  it("proceeds on non-conflict states GitHub's own checks handle", () => {
    // `behind`/`blocked`/`unstable` are not conflicts: the strict required-check
    // handles "out of date" and the others are CI/state, not a merge conflict.
    // Rebasing for them would be needless churn.
    expect(classifyMergeability(false, "behind")).toBe("proceed");
    expect(classifyMergeability(false, "blocked")).toBe("proceed");
    expect(classifyMergeability(false, "unstable")).toBe("proceed");
  });

  it("is unknown while GitHub is still computing mergeability (mergeable null)", () => {
    // null wins regardless of the state string, which is often "unknown"/"checking"
    // in that window; the caller polls, then falls open to proceed.
    expect(classifyMergeability(null, "unknown")).toBe("unknown");
    expect(classifyMergeability(null, "dirty")).toBe("unknown");
  });
});
