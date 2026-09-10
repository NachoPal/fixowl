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

/**
 * The two credentials that authenticate the native `claude` adapter, and the
 * env var each rides in. Claude Code accepts either:
 *  - `CLAUDE_CODE_OAUTH_TOKEN` - a long-lived token tied to a Claude
 *    subscription (`claude setup-token`); the run bills against the
 *    subscription's rolling usage window (readable out-of-band, agent-usage.ts).
 *  - `ANTHROPIC_API_KEY` - a Console API key; the run bills as metered API
 *    usage, with no usage window to read. The `total_token_budget` cap is
 *    accepted for this credential in config, but is NOT yet enforced in-band:
 *    the claude spend meter abstains fail-open (agent-spend.ts). See the argv
 *    comment below for why (verify_before_fix parses claude fix-mode stdout as
 *    plain text, so fixowl must not switch it to `--output-format json`).
 *
 * PRECEDENCE (the reason both must never reach the container at once): in
 * headless `claude -p` mode `ANTHROPIC_API_KEY` WINS over
 * `CLAUDE_CODE_OAUTH_TOKEN` when both are set (Claude Code auth precedence:
 * API key is checked before the OAuth token, and in `-p` a present key is
 * always used). So if both were passed, a "subscription" run would silently
 * bill as API usage. fixowl avoids the fight structurally: `fixowl init` writes
 * an EXCLUSIVE per-agent env allowlist (exactly one of these vars), so only the
 * credential the operator chose ever enters the container. The adapter's
 * default allowlist lists both only so either can be the chosen credential.
 */
export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * The env var carrying codex's OpenAI API key. codex authenticates ONLY via
 * this key (its ChatGPT-subscription OAuth-file path is unsupported), so the
 * name is fixed here and the codex adapter's runtime login reads it by this
 * exact name. `fixowl init` writes `codex: { env: [OPENAI_API_KEY] }`.
 */
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

/**
 * Establishes codex's file-based auth from the forwarded API key, then execs the
 * real `codex exec ...` (which rides as the shell's positional parameters, so no
 * model/effort value is ever interpolated into the shell string). Verified
 * against codex-cli 0.153.4: `codex exec` does NOT authenticate from
 * `OPENAI_API_KEY` in the environment - it detects the var but sends no bearer
 * token, so the OpenAI endpoint returns `401 ... Missing bearer or basic
 * authentication in header`. Auth is a file (`$CODEX_HOME/auth.json`) written by
 * `codex login --with-api-key`, which reads the key from stdin and prints ONLY to
 * stderr (so the fix-mode `--json` JSONL stream on stdout stays clean for
 * parseCodexUsage). Notes:
 *  - `printf %s "$OPENAI_API_KEY" | codex login` feeds login its own pipe; the
 *    issue prompt fixowl pipes to the container stays on the shell's stdin and is
 *    inherited by `exec codex exec` (login never touches it).
 *  - `&&` makes a missing/empty key fail loudly (login exits non-zero) instead of
 *    the previous silent 401.
 *  - `exec` replaces the shell so codex owns the process (signals, exit code, the
 *    container-timeout `docker rm -f <name>` all behave as before).
 *  - auth.json lands in the container's ephemeral `HOME` (container-exec.ts sets
 *    HOME=/tmp) and dies with the `--rm` container; the key is never written to a
 *    host disk or an image layer, and only its NAME (`$OPENAI_API_KEY`) - never
 *    its value - appears in the argv.
 */
export const CODEX_LOGIN_THEN_EXEC = `printf %s "$${OPENAI_API_KEY_ENV}" | codex login --with-api-key 1>&2 && exec "$@"`;

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
  // Both credentials are allowlisted so either can be the chosen one; `fixowl
  // init` writes an EXCLUSIVE override (exactly one) so they never both reach
  // the container - see CLAUDE_OAUTH_TOKEN_ENV / ANTHROPIC_API_KEY_ENV above for
  // the precedence footgun this avoids. Neither is a GitHub credential, so both
  // stay off FORBIDDEN_AGENT_ENV.
  env: [CLAUDE_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV],
  promptVia: "stdin",
  // --dangerously-skip-permissions is safe here because the container is the
  // sandbox: no GitHub token, no docker socket, cap-drop ALL, resource limits.
  // The CLI hard-refuses this flag under uid 0, so the container must run
  // non-root (docker `--user`, injected in DockerEngine.run).
  // The Claude Code CLI accepts --model and --effort in -p (headless) mode.
  //
  // claude fix-mode stdout is consumed as PLAIN TEXT: verify_before_fix's
  // parseVerdict (issue-pipeline.ts / verdict.ts, from #143) reads a
  // `FIXOWL_VERDICT: {...}` line the agent prints to stdout, and classify parses
  // the final message out of raw stdout (main.ts::parseClassification). So fixowl
  // must NOT switch fix mode to `--output-format json`: the JSON wrapper escapes
  // the verdict marker's quotes and breaks parseVerdict. As a consequence the
  // in-band token meter for claude abstains (agent-spend.ts), so enforcing
  // `total_token_budget` for claude-on-ANTHROPIC_API_KEY is a documented
  // follow-up that needs a json-safe verdict path; codex remains the metered
  // API-credit agent.
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

const codex: AgentAdapter = {
  name: "codex",
  // Deliberately empty: codex needs a paid credential, so the operator opts one
  // in explicitly via config, e.g.
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
  //
  // `--json` (fix mode only) turns stdout into a JSONL event stream whose
  // `turn.completed` events carry a `usage` object, which the host parses in-band
  // for the `total_token_budget` run budget (agent-spend.ts::parseCodexUsage).
  // It is NOT set in classify mode: classify parses the agent's final message out
  // of raw stdout (main.ts::parseClassification), which JSONL would break; a
  // single classify call's token spend is a negligible, accepted under-count.
  //
  // The run is wrapped in `bash -c '<login> && exec "$@"'` because `codex exec`
  // does not read the API key from the environment; the login step writes
  // codex's auth file first, from the same `OPENAI_API_KEY` that rides the env
  // allowlist. See CODEX_LOGIN_THEN_EXEC above. The `codex exec ...` array is
  // passed as the shell's positional args (`"$@"`), never interpolated.
  argv: (mode, selection) => [
    "bash",
    "-c",
    CODEX_LOGIN_THEN_EXEC,
    // $0 for `bash -c`; a label, not executed (the script uses only "$@").
    "codex",
    "codex",
    "exec",
    ...(mode === "fix" ? ["--json"] : []),
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

const ADAPTERS: Record<string, AgentAdapter> = { claude, codex, script };

/**
 * Env var names that would hand the agent a GitHub credential. "The coding
 * agent never holds a GitHub token" is a hard invariant, so the allowlist
 * refuses these structurally instead of trusting configuration discipline:
 * a workflow or config naming one fails the night loudly at startup.
 */
export const FORBIDDEN_AGENT_ENV: readonly string[] = [
  "FIXOWL_APP_PRIVATE_KEY",
  "FIXOWL_APP_ID",
  "FIXOWL_APP_INSTALLATION_ID",
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
