import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { renderFixowlWorkflow, type WorkflowTemplateOptions } from "./workflow-template.ts";

type WorkflowStep = {
  uses?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: { name?: string };
};

function fixowlJobSteps(rendered: string): WorkflowStep[] {
  const doc = parseYaml(rendered) as { jobs: { fixowl: { steps: WorkflowStep[] } } };
  return doc.jobs.fixowl.steps;
}

const baseOptions: WorkflowTemplateOptions = {
  schedule: "30 1 * * *",
  labels: { any: ["overnight"] },
  agent: "claude",
  agentEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
  maxIssuesPerRun: 4,
  issueTimeoutMinutes: 45,
  ciMaxTries: 3,
  ciTimeoutMinutes: 60,
  actionRef: "NachoPal/fixowl@0000000000000000000000000000000000000000",
  actionRefComment: "main @ 2026-09-02",
};

describe("renderFixowlWorkflow", () => {
  it("renders the full scheduled workflow", () => {
    expect(renderFixowlWorkflow(baseOptions)).toMatchSnapshot();
  });

  it("omits the schedule with --no-schedule", () => {
    const rendered = renderFixowlWorkflow({ ...baseOptions, schedule: null });
    expect(rendered).not.toContain("schedule:");
    expect(rendered).toContain("workflow_dispatch");
  });

  it("swapping to the cloud is the runs-on line only", () => {
    const selfHosted = renderFixowlWorkflow(baseOptions);
    const cloud = renderFixowlWorkflow({ ...baseOptions, runsOn: "ubuntu-latest" });
    const diff = selfHosted.split("\n").filter((line, i) => cloud.split("\n")[i] !== line);
    expect(diff).toEqual(["    runs-on: [self-hosted, fixowl]"]);
  });

  it("uses GITHUB_TOKEN only as the read-only budget guard, and has no container key", () => {
    const rendered = renderFixowlWorkflow(baseOptions);
    // The App installation token authors PRs, so the target repo's CI triggers
    // on them - GITHUB_TOKEN never does that.
    expect(rendered).toContain("FIXOWL_APP_ID: ${{ secrets.FIXOWL_APP_ID }}");
    // GITHUB_TOKEN appears exactly once, as the ephemeral Actions: read token the
    // once-a-day budget guard lists runs with; never a secrets.* value.
    expect(rendered).not.toContain("secrets.GITHUB_TOKEN");
    expect(rendered.match(/GITHUB_TOKEN/g) ?? []).toEqual(["GITHUB_TOKEN"]);
    expect(rendered).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(rendered).not.toContain("container:");
  });

  it("wires every agent env var from a same-named secret", () => {
    const rendered = renderFixowlWorkflow({ ...baseOptions, agentEnv: ["A_TOKEN", "B_TOKEN"] });
    expect(rendered).toContain("A_TOKEN: ${{ secrets.A_TOKEN }}");
    expect(rendered).toContain("B_TOKEN: ${{ secrets.B_TOKEN }}");
  });

  it("renders the CI-gated loop inputs", () => {
    const rendered = renderFixowlWorkflow(baseOptions);
    expect(rendered).toContain('max-ci-tries: "3"');
    expect(rendered).toContain('ci-timeout-minutes: "60"');
  });

  it("omits model inputs when unset (today's workflows are unchanged)", () => {
    const rendered = renderFixowlWorkflow(baseOptions);
    expect(rendered).not.toContain("default-model:");
    expect(rendered).not.toContain("default-effort:");
    expect(rendered).not.toContain("label-models:");
  });

  it("omits run-budget inputs when unset, and renders each when set", () => {
    const bare = renderFixowlWorkflow(baseOptions);
    expect(bare).not.toContain("usage-budget-percent:");
    expect(bare).not.toContain("total-token-budget:");
    expect(bare).not.toContain("run-budget-minutes:");
    const rendered = renderFixowlWorkflow({
      ...baseOptions,
      usageBudgetPercent: 85,
      totalTokenBudget: 3_000_000,
      runBudgetMinutes: 240,
    });
    expect(rendered).toContain('usage-budget-percent: "85"');
    expect(rendered).toContain('total-token-budget: "3000000"');
    expect(rendered).toContain('run-budget-minutes: "240"');
  });

  it("omits heuristic-conflict-ordering when off (default), renders it when on", () => {
    expect(renderFixowlWorkflow(baseOptions)).not.toContain("heuristic-conflict-ordering:");
    expect(
      renderFixowlWorkflow({ ...baseOptions, heuristicConflictOrdering: false }),
    ).not.toContain("heuristic-conflict-ordering:");
    expect(renderFixowlWorkflow({ ...baseOptions, heuristicConflictOrdering: true })).toContain(
      'heuristic-conflict-ordering: "true"',
    );
  });

  it("renders triage inputs only on opt-out (default-on stays byte-for-byte stable)", () => {
    // Default and explicit-true render nothing (the action defaults them true).
    for (const value of [undefined, true]) {
      const rendered = renderFixowlWorkflow({
        ...baseOptions,
        skipAlreadyFixed: value,
        skipDuplicates: value,
        verifyBeforeFix: value,
      });
      expect(rendered).not.toContain("skip-already-fixed:");
      expect(rendered).not.toContain("skip-duplicates:");
      expect(rendered).not.toContain("verify-before-fix:");
    }
    // Opt-out renders the "false" input.
    const optedOut = renderFixowlWorkflow({
      ...baseOptions,
      skipAlreadyFixed: false,
      skipDuplicates: false,
      verifyBeforeFix: false,
    });
    expect(optedOut).toContain('skip-already-fixed: "false"');
    expect(optedOut).toContain('skip-duplicates: "false"');
    expect(optedOut).toContain('verify-before-fix: "false"');
  });

  it("renders default model/effort and a JSON label-models input when set", () => {
    const rendered = renderFixowlWorkflow({
      ...baseOptions,
      defaultModel: "sonnet",
      defaultEffort: "medium",
      labelModels: { heavy: { model: "opus", effort: "max" } },
    });
    expect(rendered).toContain('default-model: "sonnet"');
    expect(rendered).toContain('default-effort: "medium"');
    expect(rendered).toContain(
      'label-models: "{\\"heavy\\":{\\"model\\":\\"opus\\",\\"effort\\":\\"max\\"}}"',
    );
    // The label-models value round-trips through JSON.parse of the YAML scalar.
    const match = /label-models: (".*")/.exec(rendered);
    expect(match).not.toBeNull();
    const yamlScalar = JSON.parse(match?.[1] ?? '""') as string;
    expect(JSON.parse(yamlScalar)).toEqual({ heavy: { model: "opus", effort: "max" } });
  });

  it("wires the GitHub App secret trio as the only runtime credential", () => {
    const rendered = renderFixowlWorkflow(baseOptions);
    expect(rendered).toContain("FIXOWL_APP_ID: ${{ secrets.FIXOWL_APP_ID }}");
    expect(rendered).toContain(
      "FIXOWL_APP_INSTALLATION_ID: ${{ secrets.FIXOWL_APP_INSTALLATION_ID }}",
    );
    expect(rendered).toContain("FIXOWL_APP_PRIVATE_KEY: ${{ secrets.FIXOWL_APP_PRIVATE_KEY }}");
    // The removed runtime-PAT secret is never wired.
    expect(rendered).not.toContain("FIXOWL_GITHUB_TOKEN");
    // The ephemeral guard token is unchanged; agent env still wired.
    expect(rendered).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(rendered).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
  });

  it("marks the end-of-job combined evidence upload continue-on-error so it can never fail the run", () => {
    const steps = fixowlJobSteps(renderFixowlWorkflow(baseOptions));
    // The combined upload is the only step that produces the single
    // `fixowl-evidence` artifact and always runs (if: always()).
    const combinedUpload = steps.filter(
      (step) => step.if === "always()" && step.with?.name === "fixowl-evidence",
    );
    expect(combinedUpload).toHaveLength(1);
    // GitHub Actions semantics: continue-on-error true means a failure of this
    // step (the intermittent FinalizeArtifact 403) does not fail the job/run.
    expect(combinedUpload[0]?.["continue-on-error"]).toBe(true);

    // No other step opts out of failure - the fix is scoped to this one upload,
    // so a real failure anywhere else still turns the run red.
    const otherContinueOnError = steps.filter(
      (step) => step.with?.name !== "fixowl-evidence" && step["continue-on-error"] === true,
    );
    expect(otherContinueOnError).toEqual([]);
  });

  it("passes actionlint when available", () => {
    try {
      execFileSync("actionlint", ["--version"], { stdio: "ignore" });
    } catch {
      console.warn("actionlint not on PATH; skipping (CI installs it)");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "fixowl-wf-"));
    const wfDir = join(dir, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const lintConfig = join(dir, "actionlint.yaml");
    writeFileSync(lintConfig, "self-hosted-runner:\n  labels: [fixowl]\n");
    const files: string[] = [];
    for (const [name, options] of [
      ["scheduled.yml", baseOptions],
      ["dispatch-only.yml", { ...baseOptions, schedule: null }],
      ["cloud.yml", { ...baseOptions, runsOn: "ubuntu-latest" }],
    ] as const) {
      const file = join(wfDir, name);
      writeFileSync(file, renderFixowlWorkflow(options));
      files.push(file);
    }
    execFileSync("actionlint", ["-config-file", lintConfig, ...files], {
      cwd: dir,
      stdio: "pipe",
    });
  });
});
