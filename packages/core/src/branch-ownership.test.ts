import { describe, expect, it } from "vitest";
import { FIXOWL_BOT_EMAIL, fixowlCommitTrailer, isFixowlBranchTip } from "./branch-ownership.ts";

describe("isFixowlBranchTip", () => {
  it("owns a tip authored by the fixowl bot identity", () => {
    expect(isFixowlBranchTip({ authorEmail: FIXOWL_BOT_EMAIL, subject: "anything" }, 7)).toBe(true);
  });

  it("matches the bot email case-insensitively and trims whitespace", () => {
    expect(
      isFixowlBranchTip({ authorEmail: `  ${FIXOWL_BOT_EMAIL.toUpperCase()} `, subject: "x" }, 7),
    ).toBe(true);
  });

  it("owns a tip whose subject is the fixowl trailer for the same issue", () => {
    expect(
      isFixowlBranchTip({ authorEmail: "dev@example.com", subject: "fix #7: Fix login" }, 7),
    ).toBe(true);
  });

  it("does not own a human-authored tip with an unrelated subject", () => {
    expect(
      isFixowlBranchTip({ authorEmail: "dev@example.com", subject: "wip: api refactor" }, 7),
    ).toBe(false);
  });

  it("does not own a tip whose trailer is for a different issue number", () => {
    expect(
      isFixowlBranchTip({ authorEmail: "dev@example.com", subject: "fix #99: something" }, 7),
    ).toBe(false);
  });

  it("exposes the trailer shape used for the check", () => {
    expect(fixowlCommitTrailer(12)).toBe("fix #12:");
  });
});
