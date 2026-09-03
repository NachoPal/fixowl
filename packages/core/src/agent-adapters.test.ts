import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentAdapterNames,
  FORBIDDEN_AGENT_ENV,
  getAgentAdapter,
  PROMPT_MOUNT_PATH,
} from "./agent-adapters.ts";

describe("agent adapters", () => {
  it("claude: headless argv, prompt on stdin, oauth token allowlisted", () => {
    const claude = getAgentAdapter("claude");
    expect(claude.argv("fix")).toEqual([
      "claude",
      "-p",
      "--dangerously-skip-permissions",
      "--max-turns",
      "80",
    ]);
    expect(claude.argv("classify")).toEqual([
      "claude",
      "-p",
      "--dangerously-skip-permissions",
      "--max-turns",
      "30",
    ]);
    expect(claude.promptVia).toBe("stdin");
    expect(claude.env).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("claude: appends --model and --effort when a selection is given", () => {
    const claude = getAgentAdapter("claude");
    expect(claude.argv("fix", { model: "opus", effort: "max" })).toEqual([
      "claude",
      "-p",
      "--dangerously-skip-permissions",
      "--max-turns",
      "80",
      "--model",
      "opus",
      "--effort",
      "max",
    ]);
    // A partial selection omits the absent flag; today's behavior (no selection).
    expect(claude.argv("fix", { effort: "low" })).toEqual([
      "claude",
      "-p",
      "--dangerously-skip-permissions",
      "--max-turns",
      "80",
      "--effort",
      "low",
    ]);
    expect(claude.argv("fix", {})).toEqual([
      "claude",
      "-p",
      "--dangerously-skip-permissions",
      "--max-turns",
      "80",
    ]);
  });

  it("aider: appends --model and --reasoning-effort when a selection is given", () => {
    const aider = getAgentAdapter("aider");
    expect(aider.argv("fix", { model: "sonnet", effort: "high" })).toEqual([
      "aider",
      "--message-file",
      PROMPT_MOUNT_PATH,
      "--yes-always",
      "--model",
      "sonnet",
      "--reasoning-effort",
      "high",
    ]);
  });

  it("aider: message file argv and an empty default env allowlist (opt-in spend)", () => {
    const aider = getAgentAdapter("aider");
    expect(aider.argv("fix")).toEqual([
      "aider",
      "--message-file",
      PROMPT_MOUNT_PATH,
      "--yes-always",
    ]);
    expect(aider.env).toEqual([]);
    expect(aider.promptVia).toBe("file");
  });

  it("script: extracts fenced bodies and runs them as bash for deterministic e2e", () => {
    const script = getAgentAdapter("script");
    const argv = script.argv("fix");
    expect(argv[0]).toBe("bash");
    expect(argv[1]).toBe("-c");
    expect(argv[2]).toContain("awk");
    expect(argv[2]).toContain(PROMPT_MOUNT_PATH);
    expect(argv[2]).toContain("| bash");
    expect(script.env).toEqual([]);
  });

  it("script: the extraction pipeline runs exactly the fenced body", () => {
    const script = getAgentAdapter("script");
    const prompt = [
      "You are fixing GitHub issue #1.",
      "<untrusted-issue-body>",
      "echo body-ran",
      "</untrusted-issue-body>",
      "Ground rules: prose that is not valid bash.",
    ].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "fixowl-script-"));
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, prompt);
    const pipeline = (script.argv("fix")[2] ?? "").replaceAll("/fixowl/prompt.md", promptFile);
    const output = execFileSync("bash", ["-c", pipeline], { encoding: "utf8" });
    expect(output.trim()).toBe("body-ran");
  });

  it("env override replaces the allowlist", () => {
    const adapter = getAgentAdapter("aider", ["ANTHROPIC_API_KEY"]);
    expect(adapter.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(getAgentAdapter("aider").env).toEqual([]);
  });

  it("the allowlist structurally refuses GitHub credentials", () => {
    for (const name of FORBIDDEN_AGENT_ENV) {
      expect(() => getAgentAdapter("claude", [name])).toThrow(/never holds a GitHub token/);
    }
    expect(() => getAgentAdapter("claude", ["ANTHROPIC_API_KEY", "gh_token"])).toThrow(
      /never holds a GitHub token/,
    );
    expect(FORBIDDEN_AGENT_ENV).toContain("FIXOWL_GITHUB_TOKEN");
  });

  it("unknown adapter throws with the known list", () => {
    expect(() => getAgentAdapter("gpt")).toThrow(/unknown agent adapter "gpt"/);
    expect(agentAdapterNames()).toEqual(["claude", "aider", "script"]);
  });
});
