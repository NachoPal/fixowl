import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderFixowlWorkflow, type WorkflowTemplateOptions } from "./workflow-template.ts";

const baseOptions: WorkflowTemplateOptions = {
  schedule: "30 1 * * *",
  labels: { any: ["overnight"] },
  agent: "claude",
  agentEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
  maxIssuesPerRun: 4,
  issueTimeoutMinutes: 45,
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
    // The runtime PAT (FIXOWL_GITHUB_TOKEN) authors PRs, so the target repo's CI
    // triggers on them - GITHUB_TOKEN never does that.
    expect(rendered).toContain("FIXOWL_GITHUB_TOKEN: ${{ secrets.FIXOWL_GITHUB_TOKEN }}");
    // GITHUB_TOKEN appears exactly once, as the ephemeral Actions: read token the
    // once-a-day budget guard lists runs with; never a secrets.* value.
    expect(rendered).not.toContain("secrets.GITHUB_TOKEN");
    expect(rendered.match(/(?<!FIXOWL_)GITHUB_TOKEN/g) ?? []).toEqual(["GITHUB_TOKEN"]);
    expect(rendered).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(rendered).not.toContain("container:");
  });

  it("wires every agent env var from a same-named secret", () => {
    const rendered = renderFixowlWorkflow({ ...baseOptions, agentEnv: ["A_TOKEN", "B_TOKEN"] });
    expect(rendered).toContain("A_TOKEN: ${{ secrets.A_TOKEN }}");
    expect(rendered).toContain("B_TOKEN: ${{ secrets.B_TOKEN }}");
  });

  it("omits model inputs when unset (today's workflows are unchanged)", () => {
    const rendered = renderFixowlWorkflow(baseOptions);
    expect(rendered).not.toContain("default-model:");
    expect(rendered).not.toContain("default-effort:");
    expect(rendered).not.toContain("label-models:");
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
