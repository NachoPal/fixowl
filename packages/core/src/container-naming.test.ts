import { describe, expect, it } from "vitest";
import {
  CONTAINER_NAME_MAX_LENGTH,
  containerName,
  containerNamePrefix,
  parseContainerName,
} from "./container-naming.ts";

describe("containerName", () => {
  it("sanitizes the repo and purpose", () => {
    expect(containerName("Acme/Web.App", 7, "check-Client Tests!")).toBe(
      "fixowl-acme-web-app-7-check-client-tests",
    );
    expect(containerName("test/repo", "classify", "claude")).toBe(
      "fixowl-test-repo-classify-claude",
    );
  });

  it("keeps names for different repos distinct (docker rm -f must never cross repos)", () => {
    expect(containerName("a/one", 7, "agent")).not.toBe(containerName("a/two", 7, "agent"));
  });

  it("clips to docker's 63-char name limit", () => {
    const longRepo = "acme/widget-service";
    const name = containerName(longRepo, 12345, "check-a-very-descriptive-verification-step-here");
    expect(name.length).toBe(CONTAINER_NAME_MAX_LENGTH);
  });
});

describe("containerNamePrefix", () => {
  it("is the shared discovery prefix and is itself a prefix of the full name", () => {
    const prefix = containerNamePrefix("Acme/Web.App");
    expect(prefix).toBe("fixowl-acme-web-app-");
    expect(containerName("Acme/Web.App", 7, "agent").startsWith(prefix)).toBe(true);
  });
});

describe("parseContainerName", () => {
  it("round-trips the issue and purpose for its repo", () => {
    const name = containerName("Acme/Web.App", 7, "agent");
    expect(parseContainerName(name, "Acme/Web.App")).toEqual({
      issue: 7,
      purpose: "agent",
      truncated: false,
    });
  });

  it("reads the classify step (no issue number)", () => {
    const name = containerName("test/repo", "classify", "claude");
    expect(parseContainerName(name, "test/repo")).toEqual({
      issue: "classify",
      purpose: "claude",
      truncated: false,
    });
  });

  it("keeps multi-segment purposes intact", () => {
    const name = containerName("test/repo", 3, "check-Client Tests");
    expect(parseContainerName(name, "test/repo")).toEqual({
      issue: 3,
      purpose: "check-client-tests",
      truncated: false,
    });
  });

  it("returns undefined for another repo's containers", () => {
    const name = containerName("a/one", 7, "agent");
    expect(parseContainerName(name, "a/two")).toBeUndefined();
  });

  it("returns undefined when the name is not a fixowl container", () => {
    expect(parseContainerName("some-other-container", "a/one")).toBeUndefined();
  });

  it("still yields the issue number when the 63-char cap truncated the purpose", () => {
    const longRepo = "acme/widget-service";
    const name = containerName(longRepo, 12345, "check-a-very-descriptive-verification-step-here");
    expect(name.length).toBe(CONTAINER_NAME_MAX_LENGTH);
    const parsed = parseContainerName(name, longRepo);
    expect(parsed?.issue).toBe(12345);
    expect(parsed?.truncated).toBe(true);
  });

  it("surfaces the issue even when truncation clipped the purpose away entirely", () => {
    // A name truncated right after the issue token, with no purpose left.
    const prefix = containerNamePrefix("a/b");
    const name = `${prefix}42`;
    expect(parseContainerName(name, "a/b")).toEqual({
      issue: 42,
      purpose: "",
      truncated: false,
    });
  });
});
