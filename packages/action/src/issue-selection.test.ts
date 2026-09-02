import { describe, expect, it } from "vitest";
import { selectIssues } from "./issue-selection.ts";
import { FakeGitHub, issue } from "./test-helpers.ts";

describe("selectIssues", () => {
  it("unions per-label queries for `any` and sorts oldest first", async () => {
    const github = new FakeGitHub([
      issue(3, "c", "", ["night"]),
      issue(1, "a", "", ["overnight"]),
      issue(2, "b", "", ["overnight", "night"]),
      issue(4, "d", "", ["unrelated"]),
    ]);
    const selected = await selectIssues(github, { any: ["overnight", "night"] });
    expect(selected.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it("requires every label for `all`", async () => {
    const github = new FakeGitHub([
      issue(1, "a", "", ["bug", "overnight"]),
      issue(2, "b", "", ["bug"]),
    ]);
    const selected = await selectIssues(github, { all: ["bug", "overnight"] });
    expect(selected.map((i) => i.number)).toEqual([1]);
  });

  it("combined any+all is an AND", async () => {
    const github = new FakeGitHub([
      issue(1, "a", "", ["overnight", "frontend"]),
      issue(2, "b", "", ["overnight"]),
      issue(3, "c", "", ["frontend"]),
    ]);
    const selected = await selectIssues(github, {
      all: ["overnight"],
      any: ["frontend", "backend"],
    });
    expect(selected.map((i) => i.number)).toEqual([1]);
  });
});
