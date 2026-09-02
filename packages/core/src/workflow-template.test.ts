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

  it("never uses GITHUB_TOKEN and has no container key", () => {
    const rendered = renderFixowlWorkflow(baseOptions);
    expect(rendered).not.toMatch(/(?<!FIXOWL_)GITHUB_TOKEN/);
    expect(rendered).not.toContain("container:");
    expect(rendered).toContain("FIXOWL_GITHUB_TOKEN: ${{ secrets.FIXOWL_GITHUB_TOKEN }}");
  });

  it("wires every agent env var from a same-named secret", () => {
    const rendered = renderFixowlWorkflow({ ...baseOptions, agentEnv: ["A_TOKEN", "B_TOKEN"] });
    expect(rendered).toContain("A_TOKEN: ${{ secrets.A_TOKEN }}");
    expect(rendered).toContain("B_TOKEN: ${{ secrets.B_TOKEN }}");
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
