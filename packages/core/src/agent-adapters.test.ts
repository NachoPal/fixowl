import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentAdapterNames,
  ANTHROPIC_API_KEY_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  CODEX_LOGIN_THEN_EXEC,
  FORBIDDEN_AGENT_ENV,
  getAgentAdapter,
  PROMPT_MOUNT_PATH,
} from "./agent-adapters.ts";

// Every codex run is `bash -c '<login> && exec "$@"' codex <codex exec ...>`:
// codex exec does not read OPENAI_API_KEY from the env, so the adapter logs in
// first (writing codex's auth file from the forwarded key) and then execs the
// real argv, which rides as the shell's positional params ($0="codex", $@=rest).
const CODEX_WRAP = ["bash", "-c", CODEX_LOGIN_THEN_EXEC, "codex"] as const;

describe("agent adapters", () => {
  it("claude: headless argv, prompt on stdin, both credentials allowlisted", () => {
    const claude = getAgentAdapter("claude");
    // Fix mode stays plain -p (no --output-format json): its stdout is parsed as
    // plain text by verify_before_fix's verdict parser, which the JSON wrapper
    // would break. classify is likewise plain -p.
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
    // Both credentials are allowlisted; init writes an exclusive override.
    expect(claude.env).toEqual([CLAUDE_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]);
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

  it("codex: exec argv, prompt on stdin, empty default env allowlist (opt-in spend)", () => {
    const codex = getAgentAdapter("codex");
    expect(codex.argv("fix")).toEqual([
      ...CODEX_WRAP,
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "-C",
      "/workspace",
    ]);
    // classify OMITS --json: it parses the agent's final message out of raw
    // stdout, which the JSONL stream would break. --json is fix-mode only (its
    // usage events feed the in-band token budget, agent-spend.ts).
    expect(codex.argv("classify")).toEqual([
      ...CODEX_WRAP,
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "-C",
      "/workspace",
    ]);
    expect(codex.argv("classify")).not.toContain("--json");
    expect(codex.promptVia).toBe("stdin");
    expect(codex.env).toEqual([]);
  });

  it("codex: logs in from the forwarded key before exec, without leaking it", () => {
    const codex = getAgentAdapter("codex");
    const argv = codex.argv("fix", { model: "gpt-5-codex", effort: "high" });
    // The run is a bash wrapper that establishes codex's file auth first.
    expect(argv.slice(0, 3)).toEqual(["bash", "-c", CODEX_LOGIN_THEN_EXEC]);
    // Only the env var NAME appears (login reads the value from it at runtime);
    // the wrapper never interpolates a secret value into the argv.
    expect(CODEX_LOGIN_THEN_EXEC).toContain("$OPENAI_API_KEY");
    expect(CODEX_LOGIN_THEN_EXEC).toContain("codex login --with-api-key");
    // login output is kept off stdout so the fix-mode --json stream stays clean.
    expect(CODEX_LOGIN_THEN_EXEC).toContain("1>&2");
    // `exec "$@"` runs the real codex exec argv passed as positional params.
    expect(CODEX_LOGIN_THEN_EXEC).toContain('exec "$@"');
  });

  it("codex: appends -m and maps effort to a -c config override when selected", () => {
    const codex = getAgentAdapter("codex");
    expect(codex.argv("fix", { model: "gpt-5-codex", effort: "high" })).toEqual([
      ...CODEX_WRAP,
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "-C",
      "/workspace",
      "-m",
      "gpt-5-codex",
      "-c",
      "model_reasoning_effort=high",
    ]);
    // A partial selection omits the absent flag.
    expect(codex.argv("fix", { model: "gpt-5.1-codex" })).toEqual([
      ...CODEX_WRAP,
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "-C",
      "/workspace",
      "-m",
      "gpt-5.1-codex",
    ]);
    expect(codex.argv("fix", { effort: "minimal" })).toEqual([
      ...CODEX_WRAP,
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "-C",
      "/workspace",
      "-c",
      "model_reasoning_effort=minimal",
    ]);
  });

  it("codex: an operator opts OPENAI_API_KEY into the allowlist via config override", () => {
    const codex = getAgentAdapter("codex", ["OPENAI_API_KEY"]);
    expect(codex.env).toEqual(["OPENAI_API_KEY"]);
    // The built-in default stays empty (no accidental spend).
    expect(getAgentAdapter("codex").env).toEqual([]);
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
    // codex ships an empty default allowlist; the operator opts its key in.
    const adapter = getAgentAdapter("codex", ["OPENAI_API_KEY"]);
    expect(adapter.env).toEqual(["OPENAI_API_KEY"]);
    expect(getAgentAdapter("codex").env).toEqual([]);
  });

  it("claude env override selects one credential exclusively (avoiding the precedence fight)", () => {
    // init writes exactly one of the two, so only the chosen credential enters
    // the container even though the default allowlist lists both.
    expect(getAgentAdapter("claude", [ANTHROPIC_API_KEY_ENV]).env).toEqual([ANTHROPIC_API_KEY_ENV]);
    expect(getAgentAdapter("claude", [CLAUDE_OAUTH_TOKEN_ENV]).env).toEqual([
      CLAUDE_OAUTH_TOKEN_ENV,
    ]);
  });

  it("the allowlist structurally refuses GitHub credentials", () => {
    for (const name of FORBIDDEN_AGENT_ENV) {
      expect(() => getAgentAdapter("claude", [name])).toThrow(/never holds a GitHub token/);
    }
    expect(() => getAgentAdapter("claude", ["ANTHROPIC_API_KEY", "gh_token"])).toThrow(
      /never holds a GitHub token/,
    );
    expect(FORBIDDEN_AGENT_ENV).toContain("FIXOWL_APP_PRIVATE_KEY");
  });

  it("unknown adapter throws with the known list", () => {
    expect(() => getAgentAdapter("gpt")).toThrow(/unknown agent adapter "gpt"/);
    expect(agentAdapterNames()).toEqual(["claude", "codex", "script"]);
  });
});
