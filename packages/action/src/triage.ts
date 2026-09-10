import type { IssueLite, IssueTriageSignals, TriageRef } from "./deps.ts";

/**
 * Pre-work issue triage (Layer A), pure. Given the fresh candidate set and the
 * read-only GitHub signals (one aliased GraphQL round-trip, `getIssueTriageSignals`),
 * split the issues into those to work and those to skip. Layer A only ever skips
 * on GitHub's own high-precision signals - a closing-keyword-linked merged PR, or
 * a marked/labeled duplicate. A bare merged-PR cross-reference is deliberately NOT
 * skipped here; that ambiguous case is left to Layer B (the agent verifies against
 * the current code). See docs/issue-triage.md.
 *
 * The only I/O is the signal fetch (at the edge in main.ts) and the comment +
 * label write main.ts performs for each triaged issue.
 */

/** The marker label fixowl stamps on a triaged-out issue so it drops out of the next night. */
export const TRIAGED_LABEL = "fixowl:triaged";

/** The conventional label a human applies to a duplicate issue. */
export const DUPLICATE_LABEL = "duplicate";

/** Which layer decided a skip, and why. `gate` = Layer A; `agent` = Layer B (issue-pipeline). */
export type TriageLayer = "gate" | "agent";

export type TriageCategory =
  | "already-fixed"
  | "duplicate"
  | "already-implemented"
  | "not-applicable"
  | "no-change";

export interface TriagedIssue {
  issue: IssueLite;
  layer: TriageLayer;
  category: TriageCategory;
  /** The fixing PR or duplicate original to link in the comment, when known. */
  ref?: TriageRef;
  /** Free-text reason (Layer B's agent explanation), sanitized before rendering. */
  explanation?: string;
}

export interface TriagePlan {
  /** Issues to hand to planning + the agent. */
  work: IssueLite[];
  /** Issues skipped by Layer A, with the reason. */
  triaged: TriagedIssue[];
}

export interface TriageOptions {
  skipAlreadyFixed: boolean;
  skipDuplicates: boolean;
}

/**
 * Layer A gate. Duplicate is checked before already-fixed (a marked duplicate is
 * the stronger "do not work this" signal). An issue with no confident signal - or
 * whose only signal is a bare cross-reference - falls through to `work`.
 */
export function planTriage(
  fresh: readonly IssueLite[],
  signals: Map<number, IssueTriageSignals>,
  options: TriageOptions,
): TriagePlan {
  const work: IssueLite[] = [];
  const triaged: TriagedIssue[] = [];
  for (const issue of fresh) {
    const signal = signals.get(issue.number);
    if (options.skipDuplicates) {
      const canonical = signal?.duplicateOf;
      const labeled = issue.labels.includes(DUPLICATE_LABEL);
      if (canonical !== undefined || labeled) {
        triaged.push({ issue, layer: "gate", category: "duplicate", ref: canonical });
        continue;
      }
    }
    if (options.skipAlreadyFixed && signal?.fixedByMergedPr !== undefined) {
      triaged.push({
        issue,
        layer: "gate",
        category: "already-fixed",
        ref: signal.fixedByMergedPr,
      });
      continue;
    }
    work.push(issue);
  }
  return { work, triaged };
}

/**
 * The comment fixowl leaves on a triaged-out issue, in the same voice as the
 * pipeline's other issue comments. `explanation` (Layer B) is already sanitized
 * by the caller. The comment names the `fixowl:triaged` label so a human knows
 * how to re-arm the issue.
 */
export function triageComment(triaged: TriagedIssue): string {
  const link = triaged.ref !== undefined ? triaged.ref.url : undefined;
  const reArm = `Remove the \`${TRIAGED_LABEL}\` label if you want fixowl to reconsider it.`;
  switch (triaged.category) {
    case "already-fixed":
      return (
        `🦉 fixowl skipped this issue and opened no PR: it looks already addressed` +
        (link !== undefined ? ` by ${link}` : "") +
        `. ${reArm}`
      );
    case "duplicate":
      return (
        `🦉 fixowl skipped this issue as a duplicate` +
        (link !== undefined ? ` of ${link}` : "") +
        ` and opened no PR. ${reArm}`
      );
    case "already-implemented":
      return (
        `🦉 fixowl checked the current code and opened no PR - this looks already implemented` +
        (triaged.explanation !== undefined ? `: ${triaged.explanation}` : "") +
        `. ${reArm}`
      );
    case "not-applicable":
      return (
        `🦉 fixowl checked the current code and opened no PR - this no longer seems to apply` +
        (triaged.explanation !== undefined ? `: ${triaged.explanation}` : "") +
        `. ${reArm}`
      );
    case "no-change":
      return (
        `🦉 fixowl ran the agent but it produced no change, so no PR was opened` +
        (triaged.explanation !== undefined ? ` (${triaged.explanation})` : "") +
        `. ${reArm}`
      );
  }
}
