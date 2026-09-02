import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYamlCheck } from "yaml";
import { repoFileConfigSchema } from "./config-schema.ts";
import { STARTER_ISSUE_TEMPLATE, STARTER_REPO_CONFIG } from "./starter-files.ts";

const templatesDir = resolve(import.meta.dirname, "..", "..", "..", "templates");

describe("starter files", () => {
  it("the starter .fixowl.yml parses against our own schema", () => {
    expect(() => repoFileConfigSchema.parse(parseYamlCheck(STARTER_REPO_CONFIG))).not.toThrow();
  });

  it("the starter issue template is valid yaml with the overnight label", () => {
    const parsed = parseYamlCheck(STARTER_ISSUE_TEMPLATE) as { labels: string[] };
    expect(parsed.labels).toEqual(["overnight"]);
  });

  it("templates/ copies stay in sync with the constants the CLI provisions", () => {
    expect(readFileSync(join(templatesDir, "fixowl.yml"), "utf8")).toBe(STARTER_REPO_CONFIG);
    expect(readFileSync(join(templatesDir, "issue-template.yml"), "utf8")).toBe(
      STARTER_ISSUE_TEMPLATE,
    );
  });
});
