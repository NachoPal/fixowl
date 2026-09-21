import { describe, expect, it } from "vitest";
import {
  CONTAINER_NAME_MAX_LENGTH,
  containerName,
  containerNamePrefix,
  CONTAINER_REPO_SLUG_MAX_LENGTH,
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

describe("long repo slugs (the issue and purpose tokens are budgeted, not clipped)", () => {
  // 52+ chars of slug: long enough that clipping the assembled name would have
  // eaten the `<issue>-<purpose>` tail entirely.
  const longRepo = "acme-platform-engineering/widget-service-frontend-renderer";

  it("keeps the issue and a purpose for a 52+ char slug", () => {
    // "/" and "-" are 1:1 in the slug, so the repo length is the slug length.
    expect(longRepo.length).toBeGreaterThanOrEqual(52);
    const name = containerName(longRepo, 12345, "agent");
    expect(name.length).toBeLessThanOrEqual(CONTAINER_NAME_MAX_LENGTH);
    expect(parseContainerName(name, longRepo)).toEqual({
      issue: 12345,
      purpose: "agent",
      truncated: false,
    });
  });

  it("gives every (issue, purpose) of a long-slug repo its own name", () => {
    const names = [
      containerName(longRepo, 12345, "agent"),
      containerName(longRepo, 12345, "check-lint"),
      containerName(longRepo, 12346, "agent"),
      containerName(longRepo, "classify", "claude"),
    ];
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(CONTAINER_NAME_MAX_LENGTH);
    }
  });

  it("keeps the discovery prefix a real prefix of long-slug names (fixowl watch)", () => {
    const prefix = containerNamePrefix(longRepo);
    expect(prefix.length).toBeLessThanOrEqual(
      CONTAINER_REPO_SLUG_MAX_LENGTH + "fixowl-".length + 1,
    );
    for (const purpose of ["agent", "check-lint"]) {
      expect(containerName(longRepo, 7, purpose).startsWith(prefix)).toBe(true);
    }
  });

  it("keeps two long repos sharing a head distinct", () => {
    const sibling = "acme-platform-engineering/widget-service-frontend-renderer-v2";
    expect(containerNamePrefix(longRepo)).not.toBe(containerNamePrefix(sibling));
    expect(containerName(longRepo, 7, "agent")).not.toBe(containerName(sibling, 7, "agent"));
    expect(parseContainerName(containerName(sibling, 7, "agent"), longRepo)).toBeUndefined();
  });

  it("still yields the issue when a long purpose is clipped on a long slug", () => {
    const name = containerName(longRepo, 12345, "check-a-very-descriptive-verification-step-here");
    expect(name.length).toBe(CONTAINER_NAME_MAX_LENGTH);
    const parsed = parseContainerName(name, longRepo);
    expect(parsed?.issue).toBe(12345);
    expect(parsed?.purpose).not.toBe("");
    expect(parsed?.truncated).toBe(true);
  });
});
