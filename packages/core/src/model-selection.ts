/**
 * Pure per-issue resolution of the model + reasoning effort the coding agent
 * runs with. An issue's labels decide: exactly one configured selector label
 * picks that label's model/effort; two or more is a loud refusal (the caller
 * fails just that issue); none falls back to the repo/global default, and then
 * to the agent CLI's own default (no flag). No I/O - the caller supplies the
 * issue's labels and the resolved config.
 */

/** A model/effort pair; either field may be absent, meaning "let the CLI decide". */
export interface ModelSelection {
  model?: string;
  effort?: string;
}

/** Selector-label name -> the model + effort it selects. Both are always present. */
export type LabelModelMap = Record<string, { model: string; effort: string }>;

export type ModelSelectionResult =
  | {
      ok: true;
      selection: ModelSelection;
      /** Where the selection came from: a matched label, the default, or the CLI's own default. */
      source: "label" | "default" | "agent-default";
      /** The matched selector label, set only when source is "label". */
      label?: string;
    }
  | {
      ok: false;
      /** The selector labels that collided on this issue. */
      conflictingLabels: string[];
      error: string;
    };

export interface ResolveModelSelectionParams {
  issueLabels: readonly string[];
  /** Selector labels configured for the repo. */
  labelModels: LabelModelMap;
  /** Repo/global default, already merged. Absent or empty means no default. */
  default?: ModelSelection;
}

export function resolveModelSelection(params: ResolveModelSelectionParams): ModelSelectionResult {
  const issueLabels = new Set(params.issueLabels);
  const matched = Object.keys(params.labelModels).filter((label) => issueLabels.has(label));

  if (matched.length >= 2) {
    return {
      ok: false,
      conflictingLabels: matched,
      error:
        `issue carries ${matched.length} fixowl model-selector labels (${matched.join(", ")}); ` +
        `refusing to guess which model to use - leave exactly one on the issue`,
    };
  }

  const only = matched[0];
  if (only !== undefined) {
    const selection = params.labelModels[only];
    if (selection !== undefined) {
      return { ok: true, selection: { ...selection }, source: "label", label: only };
    }
  }

  const fallback = params.default;
  if (fallback !== undefined && (fallback.model !== undefined || fallback.effort !== undefined)) {
    return {
      ok: true,
      selection: { model: fallback.model, effort: fallback.effort },
      source: "default",
    };
  }

  return { ok: true, selection: {}, source: "agent-default" };
}
