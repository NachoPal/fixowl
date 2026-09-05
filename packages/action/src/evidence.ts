import { join } from "node:path";

/**
 * Evidence directory and artifact naming, shared by the night runner (which
 * writes and progressively uploads it), the PR body (which links to it), and the
 * real uploader. Kept pure (path + string only) so pr-body.ts stays I/O-free.
 */

/**
 * Root directory under `RUNNER_TEMP` holding one `issue-<n>/` subdir per issue.
 * The generated workflow's end-of-job `upload-artifact` step uploads this whole
 * tree as the `fixowl-evidence` artifact (the fully-successful-run fallback).
 */
export const EVIDENCE_ROOT_DIRNAME = "fixowl-evidence";

/** Absolute path to one issue's evidence directory under the run's temp dir. */
export function issueEvidenceDir(tempDir: string, issueNumber: number): string {
  return join(tempDir, EVIDENCE_ROOT_DIRNAME, `issue-${issueNumber}`);
}

/**
 * Artifact name for one issue's progressively-uploaded evidence. Per-issue names
 * are required, not a fallback preference: `@actions/artifact` v2+ forbids two
 * artifacts sharing a name within one run, so a single incrementally-updated
 * artifact is impossible. Progressive per-issue uploads finalize mid-job and so
 * survive a later job cancellation, unlike the single end-of-job step.
 */
export function issueEvidenceArtifactName(issueNumber: number): string {
  return `${EVIDENCE_ROOT_DIRNAME}-issue-${issueNumber}`;
}
