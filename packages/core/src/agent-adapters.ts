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

const ADAPTERS: Record<string, AgentAdapter> = { claude, aider, script };

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
