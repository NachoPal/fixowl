import { describe, expect, it } from "vitest";
import {
  issueMatchesLabelRule,
  labelQueriesForRule,
  labelRuleSchema,
  labelsInRule,
} from "./labels.ts";

describe("labelRuleSchema", () => {
  it("accepts any-only, all-only, and combined", () => {
    expect(labelRuleSchema.parse({ any: ["overnight"] })).toEqual({ any: ["overnight"] });
    expect(labelRuleSchema.parse({ all: ["bug", "overnight"] })).toEqual({
      all: ["bug", "overnight"],
    });
    expect(labelRuleSchema.parse({ any: ["a"], all: ["b"] })).toEqual({ any: ["a"], all: ["b"] });
  });

  it("rejects an empty rule", () => {
    expect(() => labelRuleSchema.parse({})).toThrow();
    expect(() => labelRuleSchema.parse({ any: [], all: [] })).toThrow();
  });
});

describe("issueMatchesLabelRule", () => {
  it("any matches any", () => {
    const rule = { any: ["overnight", "night"] };
    expect(issueMatchesLabelRule(["night"], rule)).toBe(true);
    expect(issueMatchesLabelRule(["bug"], rule)).toBe(false);
  });

  it("all requires all", () => {
    const rule = { all: ["bug", "overnight"] };
    expect(issueMatchesLabelRule(["bug", "overnight", "x"], rule)).toBe(true);
    expect(issueMatchesLabelRule(["bug"], rule)).toBe(false);
  });

  it("any and all together are AND", () => {
    const rule = { any: ["frontend", "backend"], all: ["overnight"] };
    expect(issueMatchesLabelRule(["overnight", "frontend"], rule)).toBe(true);
    expect(issueMatchesLabelRule(["overnight"], rule)).toBe(false);
    expect(issueMatchesLabelRule(["frontend"], rule)).toBe(false);
  });
});

describe("labelQueriesForRule", () => {
  it("uses one AND query when all is present", () => {
    expect(labelQueriesForRule({ all: ["bug", "overnight"], any: ["a", "b"] })).toEqual([
      "bug,overnight",
    ]);
  });

  it("uses one query per any label", () => {
    expect(labelQueriesForRule({ any: ["a", "b"] })).toEqual(["a", "b"]);
  });
});

describe("labelsInRule", () => {
  it("dedupes across any and all", () => {
    expect(labelsInRule({ any: ["overnight", "x"], all: ["overnight"] })).toEqual([
      "overnight",
      "x",
    ]);
  });
});
