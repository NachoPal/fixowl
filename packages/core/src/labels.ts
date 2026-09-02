import { z } from "zod";

/**
 * Label rule: an issue is selected when it carries ALL of `all` and, if `any`
 * is non-empty, at least one of `any`. Both present means AND of the two.
 */
export const labelRuleSchema = z
  .object({
    any: z.array(z.string().min(1)).optional(),
    all: z.array(z.string().min(1)).optional(),
  })
  .refine((rule) => (rule.any?.length ?? 0) > 0 || (rule.all?.length ?? 0) > 0, {
    message: "label rule needs at least one label under `any` or `all`",
  });

export interface LabelRule {
  any?: string[];
  all?: string[];
}

export function issueMatchesLabelRule(issueLabels: readonly string[], rule: LabelRule): boolean {
  const labels = new Set(issueLabels);
  const all = rule.all ?? [];
  const any = rule.any ?? [];
  if (!all.every((label) => labels.has(label))) return false;
  if (any.length > 0 && !any.some((label) => labels.has(label))) return false;
  return true;
}

/**
 * The GitHub "list issues" endpoint treats its `labels` parameter as AND.
 * For `all` rules one call suffices; for `any` rules we need one call per
 * label and a client-side union. Results are always re-filtered with
 * issueMatchesLabelRule, which also covers the combined any+all case.
 */
export function labelQueriesForRule(rule: LabelRule): string[] {
  const all = rule.all ?? [];
  const any = rule.any ?? [];
  if (all.length > 0) return [all.join(",")];
  return any.map((label) => label);
}

/** Every label mentioned by the rule; provisioning ensures these exist on the repo. */
export function labelsInRule(rule: LabelRule): string[] {
  return [...new Set([...(rule.any ?? []), ...(rule.all ?? [])])];
}
