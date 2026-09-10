import type { LabelRule } from "./labels.ts";
import {
  APP_ID_SECRET,
  APP_INSTALLATION_ID_SECRET,
  APP_PRIVATE_KEY_SECRET,
} from "./secret-names.ts";

/**
 * Renders the workflow file fixowl provisions into each target repo.
 *
 * The workflow is deliberately dumb: all logic lives in the fixowl action.
 * There is no `container:` key anywhere; containerization is expressed only as
 * the action's own explicit `docker run`, which is what keeps this file
 * portable: swapping `runs-on` to `ubuntu-latest` is the one-line cloud move.
 */

export const WORKFLOW_PATH = ".github/workflows/fixowl.yml";

const CHECKOUT_PIN = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6";
const UPLOAD_ARTIFACT_PIN = "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4 # v5";

export interface WorkflowTemplateOptions {
  /** Cron expression, or null for workflow_dispatch only (provision --no-schedule). */
  schedule: string | null;
  labels: LabelRule;
  agent: string;
  /** Env var names the agent adapter needs; each is wired from a same-named repo secret. */
  agentEnv: readonly string[];
  maxIssuesPerRun: number;
  /** Usage-budget stop % (issue #21); the input is rendered only when set. */
  usageBudgetPercent?: number;
  /** Total-token hard cap for an API-credit agent; the input is rendered only when set. */
  totalTokenBudget?: number;
  /** Graceful wall-clock stop in minutes (issue #21); rendered only when set. */
  runBudgetMinutes?: number;
  issueTimeoutMinutes: number;
  /** Max agent passes in the CI-gated fix loop. */
  ciMaxTries: number;
  /** Minutes each pass waits for the pushed head's required checks. */
  ciTimeoutMinutes: number;
  /** Default model for issues carrying no selector label; omitted when unset. */
  defaultModel?: string;
  /** Default reasoning effort for issues carrying no selector label; omitted when unset. */
  defaultEffort?: string;
  /** Selector-label -> {model, effort} map; omitted when empty. */
  labelModels?: Record<string, { model: string; effort: string }>;
  /**
   * Opt-in Layer 2 heuristic conflict-ordering; the input is rendered only when
   * true, so a default-off workflow stays byte-for-byte as before.
   */
  heuristicConflictOrdering?: boolean;
  /** e.g. "NachoPal/fixowl@<sha>" */
  actionRef: string;
  /** Trailing comment after the action ref, e.g. "v0 (main @ 2026-09-02)". */
  actionRefComment?: string;
  /** Defaults to the self-hosted fixowl runner; set "ubuntu-latest" for cloud. */
  runsOn?: string;
}

export function renderFixowlWorkflow(options: WorkflowTemplateOptions): string {
  const runsOn = options.runsOn ?? "[self-hosted, fixowl]";
  // The `source` input lets the local fallback trigger tag its dispatch
  // (source: scheduled-fallback), which the run-name surfaces as a marker and
  // the action's once-a-day budget guard reads. Manual runs leave it blank.
  const dispatchBlock = `  workflow_dispatch:
    inputs:
      source:
        description: "Internal: the local fallback trigger sets this to scheduled-fallback; leave blank for manual runs."
        required: false
        default: ""`;
  const onBlock = options.schedule
    ? `on:
  schedule:
    - cron: "${options.schedule}"
${dispatchBlock}`
    : `on:
${dispatchBlock}`;

  // The runtime credential is the GitHub App secret trio, sealed by `fixowl
  // provision`; the action mints (and auto-refreshes) an installation token
  // from it. Agent env vars follow, each wired from a same-named secret.
  const runtimeSecretNames = [APP_ID_SECRET, APP_INSTALLATION_ID_SECRET, APP_PRIVATE_KEY_SECRET];
  const secretEnv = [...runtimeSecretNames, ...options.agentEnv]
    .map((name) => `          ${name}: \${{ secrets.${name} }}`)
    .join("\n");

  const refComment = options.actionRefComment ? ` # ${options.actionRefComment}` : "";

  // Model/effort inputs are only rendered when set, so today's workflows (no
  // model selection) are byte-for-byte unchanged. label-models is a JSON string.
  const withLines = [
    `          labels-any: "${(options.labels.any ?? []).join(",")}"`,
    `          labels-all: "${(options.labels.all ?? []).join(",")}"`,
    `          agent: ${options.agent}`,
    `          agent-env: "${options.agentEnv.join(",")}"`,
    `          max-issues-per-run: "${options.maxIssuesPerRun}"`,
    `          issue-timeout-minutes: "${options.issueTimeoutMinutes}"`,
    `          max-ci-tries: "${options.ciMaxTries}"`,
    `          ci-timeout-minutes: "${options.ciTimeoutMinutes}"`,
    `          source: "\${{ github.event.inputs.source }}"`,
  ];
  // The cron is passed to the action so its once-a-day budget guard can anchor
  // the "already ran" window to the schedule occurrence (correct across UTC
  // midnight) rather than the UTC calendar day. Omitted for a dispatch-only
  // workflow, where the guard degrades to the calendar day harmlessly.
  if (options.schedule) {
    withLines.push(`          schedule: "${options.schedule}"`);
  }
  // Run-budget inputs are rendered only when set, so a workflow that leaves the
  // usage / wall-clock axes opted out stays byte-for-byte as before.
  if (options.usageBudgetPercent !== undefined) {
    withLines.push(`          usage-budget-percent: "${options.usageBudgetPercent}"`);
  }
  if (options.totalTokenBudget !== undefined) {
    withLines.push(`          total-token-budget: "${options.totalTokenBudget}"`);
  }
  if (options.runBudgetMinutes !== undefined) {
    withLines.push(`          run-budget-minutes: "${options.runBudgetMinutes}"`);
  }
  if (options.defaultModel !== undefined) {
    withLines.push(`          default-model: "${options.defaultModel}"`);
  }
  if (options.defaultEffort !== undefined) {
    withLines.push(`          default-effort: "${options.defaultEffort}"`);
  }
  if (options.labelModels !== undefined && Object.keys(options.labelModels).length > 0) {
    // Double JSON.stringify: the inner JSON becomes a YAML double-quoted scalar.
    withLines.push(
      `          label-models: ${JSON.stringify(JSON.stringify(options.labelModels))}`,
    );
  }
  // Layer 2 is opt-in; render the input only when enabled so today's default-off
  // workflows are unchanged and the action's own "false" default applies.
  if (options.heuristicConflictOrdering === true) {
    withLines.push(`          heuristic-conflict-ordering: "true"`);
  }

  return `# Generated by fixowl. Re-run \`fixowl provision\` to update; manual edits will be overwritten.
name: fixowl
run-name: "fixowl night run\${{ github.event.inputs.source == 'scheduled-fallback' && ' [scheduled-fallback]' || '' }}"

${onBlock}

permissions:
  contents: read
  actions: read # the once-a-day budget guard lists this workflow's runs

concurrency:
  group: fixowl
  cancel-in-progress: false

jobs:
  fixowl:
    runs-on: ${runsOn}
    timeout-minutes: 300
    steps:
      # Security guard: if a previous run was hard-killed mid-night, the
      # workspace .git may be one an agent container planted. Checkout must
      # never run git against it, so every night starts from a clean clone.
      - name: Reset workspace git state
        run: rm -rf "$GITHUB_WORKSPACE/.git" "$GITHUB_WORKSPACE.fixowl-git"

      - uses: ${CHECKOUT_PIN}
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: ${options.actionRef}${refComment}
        with:
${withLines.join("\n")}
        env:
          GITHUB_TOKEN: \${{ github.token }} # Actions: read, for the once-a-day budget guard
${secretEnv}

      # Best-effort combined upload. Per-issue \`fixowl-evidence-issue-<n>\`
      # artifacts (uploaded progressively as each issue finishes) are the
      # primary mechanism; this end-of-job combined artifact is only a
      # convenience fallback for a fully-successful night. Its FinalizeArtifact
      # step intermittently 403s (a cancelled-job runner reconnect, or a
      # transient artifact-service error), so it must never fail the whole run.
      - uses: ${UPLOAD_ARTIFACT_PIN}
        if: always()
        continue-on-error: true
        with:
          name: fixowl-evidence
          path: \${{ runner.temp }}/fixowl-evidence/
          if-no-files-found: ignore
`;
}
