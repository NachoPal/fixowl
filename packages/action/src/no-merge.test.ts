import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Product invariant: fixowl NEVER merges. This test greps every source file in
 * every package for merge-shaped API calls so the invariant cannot regress
 * silently. If you hit this in a legitimate refactor, you are probably about
 * to break the product's core promise; stop.
 */

const FORBIDDEN = [
  /pulls\.merge/,
  /merge_method/,
  /\/merge["'`]/,
  /["'`]merge["'`]/,
  /mergePullRequest/i,
  /enableAutoMerge/i,
  /auto[_-]merge/i,
  // The "Merge a branch" REST API and ref force-updates can merge without
  // ever saying "pulls.merge"; the runtime PAT (Contents RW) could do both.
  /repos\.merge\b/,
  /\/merges\b/,
  /updateRef/i,
];

function sourceFiles(): string[] {
  const packagesDir = resolve(import.meta.dirname, "..", "..");
  return readdirSync(packagesDir, { recursive: true, encoding: "utf8" })
    .filter(
      (path) =>
        /\/src\/.*\.ts$/.test(path) && !path.endsWith(".test.ts") && !path.includes("node_modules"),
    )
    .map((path) => join(packagesDir, path));
}

describe("never-merge invariant", () => {
  it("scans a plausible set of sources", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith("entry.ts"))).toBe(true);
  });

  it("no source file contains a merge call", () => {
    for (const file of sourceFiles()) {
      const content = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(content), `${file} matches forbidden pattern ${pattern}`).toBe(false);
      }
    }
  });
});
