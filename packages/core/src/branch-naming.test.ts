import { describe, expect, it } from "vitest";
import {
  issueBranchName,
  issueBranchPrefix,
  issueNumberFromBranch,
  slugify,
} from "./branch-naming.ts";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Fix the Login Button")).toBe("fix-the-login-button");
  });

  it("strips accents and symbols", () => {
    expect(slugify("Añadir café ☕ (v2)!")).toBe("anadir-cafe-v2");
  });

  it("truncates long titles without trailing dash", () => {
    const slug = slugify("a".repeat(30) + " " + "b".repeat(30));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back for empty or all-symbol titles", () => {
    expect(slugify("!!!")).toBe("untitled");
    expect(slugify("")).toBe("untitled");
  });
});

describe("branch names", () => {
  it("round-trips the issue number", () => {
    const branch = issueBranchName(42, "Fix the thing");
    expect(branch).toBe("issue/42-fix-the-thing");
    expect(issueNumberFromBranch(branch)).toBe(42);
  });

  it("prefix does not confuse issue 12 with 123", () => {
    expect("issue/123-foo".startsWith(issueBranchPrefix(12))).toBe(false);
    expect("issue/12-foo".startsWith(issueBranchPrefix(12))).toBe(true);
  });

  it("rejects non-issue branches", () => {
    expect(issueNumberFromBranch("main")).toBeNull();
    expect(issueNumberFromBranch("issue/abc-def")).toBeNull();
    expect(issueNumberFromBranch("issues/12-x")).toBeNull();
  });
});
