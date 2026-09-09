import { describe, expect, it } from "vitest";
import {
  FIXOWL_BOT_EMAIL,
  FIXOWL_DEFAULT_GIT_IDENTITY,
  fixowlCommitTrailer,
  isFixowlBranchTip,
} from "./branch-ownership.ts";

const APP_BOT_EMAIL = "12345+fixowl-app[bot]@users.noreply.github.com";

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

  it("owns a tip authored by the resolved App bot email", () => {
    expect(
      isFixowlBranchTip({ authorEmail: APP_BOT_EMAIL, subject: "wip: nothing" }, 7, APP_BOT_EMAIL),
    ).toBe(true);
  });

  it("matches the App bot email case-insensitively and trims whitespace", () => {
    expect(
      isFixowlBranchTip(
        { authorEmail: `  ${APP_BOT_EMAIL.toUpperCase()} `, subject: "wip" },
        7,
        APP_BOT_EMAIL,
      ),
    ).toBe(true);
  });

  it("still owns a legacy-email tip even when an App bot email is supplied (mixed versions)", () => {
    expect(
      isFixowlBranchTip({ authorEmail: FIXOWL_BOT_EMAIL, subject: "wip" }, 7, APP_BOT_EMAIL),
    ).toBe(true);
  });

  it("does not own a human tip when neither the legacy nor the App email matches", () => {
    expect(
      isFixowlBranchTip(
        { authorEmail: "dev@example.com", subject: "wip: refactor" },
        7,
        APP_BOT_EMAIL,
      ),
    ).toBe(false);
  });
});

describe("FIXOWL_DEFAULT_GIT_IDENTITY", () => {
  it("falls back to the legacy identity so its branches stay owned", () => {
    expect(FIXOWL_DEFAULT_GIT_IDENTITY.email).toBe(FIXOWL_BOT_EMAIL);
    expect(
      isFixowlBranchTip({ authorEmail: FIXOWL_DEFAULT_GIT_IDENTITY.email, subject: "x" }, 1),
    ).toBe(true);
  });
});
