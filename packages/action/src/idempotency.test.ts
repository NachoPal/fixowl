import { describe, expect, it } from "vitest";
import { filterAlreadyAttempted } from "./idempotency.ts";
import { issue } from "./test-helpers.ts";

describe("filterAlreadyAttempted", () => {
  it("skips issues that already have a branch, keeps the rest", () => {
    const issues = [issue(12, "a"), issue(15, "b"), issue(123, "c")];
    const { selected, skipped } = filterAlreadyAttempted(issues, [
      "issue/12-something",
      "issue/999-old",
    ]);
    expect(selected.map((i) => i.number)).toEqual([15, 123]);
    expect(skipped).toEqual([{ issue: issues[0], branch: "issue/12-something" }]);
  });

  it("issue 12's branch does not shadow issue 123", () => {
    const { selected } = filterAlreadyAttempted([issue(123, "c")], ["issue/12-a"]);
    expect(selected.map((i) => i.number)).toEqual([123]);
  });

  it("slug drift does not defeat idempotency (prefix match only)", () => {
    const { skipped } = filterAlreadyAttempted(
      [issue(7, "retitled issue")],
      ["issue/7-original-title"],
    );
    expect(skipped).toHaveLength(1);
  });
});
