/**
 * Agent adapters describe how to invoke a coding agent inside the per-issue
 * container. The argv is exec'd directly (never through a shell), and `env` is
 * the ONLY set of environment variables that enters the container: it is both
 * the credential plumbing and the spend-control allowlist.
 */

import type { ModelSelection } from "./model-selection.ts";

export type AgentMode = "fix" | "classify";

/** Path the prompt file is mounted at (read-only) for `promptVia: "file"` adapters. */
export const PROMPT_MOUNT_PATH = "/fixowl/prompt.md";

/**
 * Where the working tree is mounted inside every container. Mirrors the action
 * package's own `WORKSPACE_MOUNT_PATH` (container-exec.ts); codex is the only
 * adapter that needs to name it (as its `--cd` root), and core cannot import
 * from the action package, so it is restated here.
 */
export const WORKSPACE_MOUNT_PATH = "/workspace";

export interface AgentAdapter {
  name: string;
  /** Env var allowlist. Default-deny: anything not listed never reaches the container. */
  env: readonly string[];
  promptVia: "stdin" | "file";
  /**
   * Argv for one agent run. `selection` carries the model/effort resolved for
   * this issue (or the repo default for classify); an absent field means the
   * flag is omitted and the CLI's own default is used.
   */
  argv(mode: AgentMode, selection?: ModelSelection): string[];
}

const claude: AgentAdapter = {
  name: "claude",
  env: ["CLAUDE_CODE_OAUTH_TOKEN"],
  promptVia: "stdin",
  // --dangerously-skip-permissions is safe here because the container is the
  // sandbox: no GitHub token, no docker socket, cap-drop ALL, resource limits.
  // The CLI hard-refuses this flag under uid 0, so the container must run
  // non-root (docker `--user`, injected in DockerEngine.run).
  // The Claude Code CLI accepts --model and --effort in -p (headless) mode.
  argv: (mode, selection) => [
    "claude",
    "-p",
    "--dangerously-skip-permissions",
    "--max-turns",
    mode === "classify" ? "30" : "80",
    ...(selection?.model !== undefined ? ["--model", selection.model] : []),
    ...(selection?.effort !== undefined ? ["--effort", selection.effort] : []),
  ],
};

const aider: AgentAdapter = {
  name: "aider",
  // Deliberately empty: aider needs a paid API key, so the operator must opt in
  // explicitly via `agents: { aider: { env: [ANTHROPIC_API_KEY] } }` in config.
  env: [],
  promptVia: "file",
  // aider takes --model and sets reasoning budget via --reasoning-effort.
  argv: (_mode, selection) => [
    "aider",
    "--message-file",
    PROMPT_MOUNT_PATH,
    "--yes-always",
    ...(selection?.model !== undefined ? ["--model", selection.model] : []),
    ...(selection?.effort !== undefined ? ["--reasoning-effort", selection.effort] : []),
  ],
};

const codex: AgentAdapter = {
  name: "codex",
  // Deliberately empty, exactly like aider: codex needs a paid credential, so
  // the operator opts one in explicitly via config, e.g.
  // `agents: { codex: { env: [OPENAI_API_KEY] } }`. This is the API-key auth
  // path; the ChatGPT/Codex subscription is a separate, file-based credential
  // that does not ride the env allowlist and is not supported yet.
  env: [],
  promptVia: "stdin",
  // `codex exec` is the non-interactive mode; with no positional prompt it reads
  // instructions from stdin. The container is the sandbox, so we disable codex's
  // own approval prompts and sandbox (which would fight `--cap-drop ALL`), and
  // fixowl moves `.git` out of the tree, so codex must tolerate a git-less root.
  // `--ephemeral` keeps codex from persisting session/rollout files. Reasoning
  // effort has no dedicated flag; it is a config override (`-c`).
  argv: (_mode, selection) => [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ephemeral",
    "-C",
    WORKSPACE_MOUNT_PATH,
    ...(selection?.model !== undefined ? ["-m", selection.model] : []),
    ...(selection?.effort !== undefined
      ? ["-c", `model_reasoning_effort=${selection.effort}`]
      : []),
  ],
};

/**
 * Test-only adapter: extracts the fenced issue body (or bodies) from the
 * prompt file and executes it as bash inside the container. Lets the whole
 * loop run end to end deterministically with zero LLM spend: sandbox issue
 * bodies are edit scripts (and can emit classification JSON in classify mode,
 * where the read-only workspace gives them away).
 */
const SCRIPT_EXTRACT_AND_RUN =
  `awk '/^<untrusted-issue-body>$/{f=1;next} /^<\\/untrusted-issue-body>$/{f=0} f' ` +
  `${PROMPT_MOUNT_PATH} | bash`;

const script: AgentAdapter = {
  name: "script",
  env: [],
  promptVia: "file",
  argv: () => ["bash", "-c", SCRIPT_EXTRACT_AND_RUN],
};

const ADAPTERS: Record<string, AgentAdapter> = { claude, aider, codex, script };

/**
 * Env var names that would hand the agent a GitHub credential. "The coding
 * agent never holds a GitHub token" is a hard invariant, so the allowlist
 * refuses these structurally instead of trusting configuration discipline:
 * a workflow or config naming one fails the night loudly at startup.
 */
export const FORBIDDEN_AGENT_ENV: readonly string[] = [
  "FIXOWL_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

export function agentAdapterNames(): string[] {
  return Object.keys(ADAPTERS);
}

export function getAgentAdapter(name: string, envOverride?: readonly string[]): AgentAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`unknown agent adapter "${name}" (known: ${agentAdapterNames().join(", ")})`);
  }
  const env = envOverride === undefined ? adapter.env : [...envOverride];
  const forbidden = env.filter((n) => FORBIDDEN_AGENT_ENV.includes(n.toUpperCase()));
  if (forbidden.length > 0) {
    throw new Error(
      `agent env allowlist may not include GitHub credentials (${forbidden.join(", ")}); ` +
        `the coding agent never holds a GitHub token`,
    );
  }
  return envOverride === undefined ? adapter : { ...adapter, env };
}
