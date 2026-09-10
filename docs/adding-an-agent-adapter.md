# Adding a new coding-agent adapter

fixowl's runner is agent-agnostic: it prepares a git-less working tree, builds a
prompt, and hands off to whatever coding agent an adapter describes, all inside a
locked-down per-issue Docker container. Teaching fixowl to drive a **new coding
agent, CLI harness, or model subscription** is the most-wanted contribution, and
it is a small, well-isolated change - usually two files plus tests.

This guide walks the exact extension points, verified against the current code.
Read [CONTRIBUTING.md](../CONTRIBUTING.md) first for setup and the hard
invariants; an adapter is exactly the kind of change those invariants exist to
protect.

## The mental model

An **adapter** answers three questions for one agent:

1. **How is it invoked?** The argv to `exec` inside the container (never through
   a shell), including how the chosen model and reasoning effort map to CLI
   flags.
2. **How does it receive the prompt?** On stdin, or from a file mounted
   read-only in the container.
3. **What credential does it need?** An **env-var allowlist**: the *only*
   environment variables that ever enter the container. This is both the
   credential plumbing and the spend-control gate.

A separate **catalog** entry declares which model ids and reasoning-effort levels
that agent accepts, so `fixowl init`, `fixowl validate`, and the config schema
can offer and validate them.

The two files you touch:

| File | What it holds |
| --- | --- |
| [`packages/core/src/agent-adapters.ts`](../packages/core/src/agent-adapters.ts) | The `AgentAdapter` definitions (`argv`, `promptVia`, `env`) and the `ADAPTERS` registry. |
| [`packages/core/src/agent-catalog.ts`](../packages/core/src/agent-catalog.ts) | `AGENT_MODEL_CATALOG`: the models and efforts each agent accepts. Its header says "Extend an agent by adding entries." |

Both live in `packages/core`, which is **pure** - no I/O. Everything downstream
(`fixowl init`, `validate`, the action, the CLI) reads these, so you rarely need
to touch anything else.

## Step 1 - define the adapter

Add an `AgentAdapter` in `agent-adapters.ts` and register it in the `ADAPTERS`
map. The interface (abridged from the source):

```ts
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
```

A worked example - suppose you are adding an agent called `mycli`, invoked as
`mycli run`, that reads its prompt from a file and authenticates with
`MYCLI_API_KEY`:

```ts
const mycli: AgentAdapter = {
  name: "mycli",
  // Deliberately empty, like codex: mycli needs a paid credential, so the
  // operator opts it in explicitly via config (see "Env-var allowlisting" below).
  env: [],
  promptVia: "file",
  argv: (_mode, selection) => [
    "mycli",
    "run",
    "--prompt-file",
    PROMPT_MOUNT_PATH,
    "--non-interactive",
    ...(selection?.model !== undefined ? ["--model", selection.model] : []),
    ...(selection?.effort !== undefined ? ["--effort", selection.effort] : []),
  ],
};
```

Then register it:

```ts
const ADAPTERS: Record<string, AgentAdapter> = { claude, codex, script, mycli };
```

Points the existing adapters demonstrate, worth copying:

- **Argv is exec'd directly, never through a shell.** Pass each token as its own
  array element - never build a command string with interpolation. (Follow the
  repo-wide convention "spawn processes with argv arrays.")
- **Non-interactive / headless mode is mandatory.** The container has no TTY and
  no human. Use the agent's headless flag (`claude -p`, `codex exec`) and
  disable any approval prompts.
- **The container is the sandbox, so bypass the agent's own sandbox.** It runs
  with `--cap-drop ALL`, resource limits, no GitHub token, and no docker socket;
  an agent's built-in sandbox would fight that. `codex` passes
  `--dangerously-bypass-approvals-and-sandbox`; `claude` passes
  `--dangerously-skip-permissions`.
- **`.git` is not in the working tree.** fixowl moves it out for the night, so if
  your agent insists on a git repo, disable that check (`codex` uses
  `--skip-git-repo-check`).
- **Model and effort are appended only when set.** Spread the flag conditionally
  (`...(selection?.model !== undefined ? [...] : [])`) so an unset value falls
  through to the CLI's own default. Map effort to whatever your CLI expects -
  `claude` uses `--effort`, `codex` maps it to
  a config override `-c model_reasoning_effort=<level>`.
- **`mode` is `"fix"` or `"classify"`.** The same argv usually works for both;
  vary it only if the agent needs it (`claude` lowers `--max-turns` for
  classify). The classify prompt already asks for JSON output.

### `promptVia`: stdin vs file

- `promptVia: "stdin"` - the prompt is piped to the process's stdin (`claude`,
  `codex`).
- `promptVia: "file"` - the prompt is written to a file mounted **read-only** at
  `PROMPT_MOUNT_PATH` (`/fixowl/prompt.md`); reference that constant in your argv
  (the `mycli` example above). Import it from
  `agent-adapters.ts`; there is also `WORKSPACE_MOUNT_PATH` (`/workspace`) if
  your CLI needs to be told where the working tree is (as `codex` does with
  `-C`).

## Step 2 - env-var allowlisting (the credential gate)

`env` is the **complete, default-deny allowlist** of environment variables that
enter the container. Anything not listed never reaches the agent - that is how
fixowl guarantees the agent cannot see a GitHub token or any other host secret.

Two rules the code enforces for you:

- **Default to an empty allowlist for any paid agent.** `codex` and the
  `mycli` example both ship `env: []` so no repo starts spending by accident. The
  operator opts the credential in explicitly in their config:

  ```yaml
  agents:
    mycli: { env: [MYCLI_API_KEY] }   # the ONLY env vars this agent ever sees
  ```

  That config override *replaces* the adapter's default `env`
  (`getAgentAdapter(name, envOverride)` in `agent-adapters.ts`). `claude` is the
  exception: its default allowlist is
  `["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]` - either a subscription
  OAuth token or a Console API key can authenticate it. Because the API key wins
  over the OAuth token in headless mode, `fixowl init` writes an **exclusive**
  override (exactly one of the two) so only the chosen credential reaches the
  container; the billing model follows the choice (see `agentBilling`).

- **GitHub credentials are refused structurally.** `getAgentAdapter` rejects any
  allowlist containing a name in `FORBIDDEN_AGENT_ENV` (`FIXOWL_APP_PRIVATE_KEY`,
  `FIXOWL_APP_ID`, `FIXOWL_APP_INSTALLATION_ID`, `GITHUB_TOKEN`, `GH_TOKEN`) and
  throws loudly at startup. You never need to (and must not) add a GitHub token
  to an adapter.

How the value flows at runtime: the action reads the allowlisted names out of
the host environment in `resolveAgentEnv` (`packages/action/src/main.ts`),
warns about any that are unset, and passes only the resolved subset into the
container. The **value** never appears in any argv - only the credential's *name*
lives in the adapter.

> **Credential shape matters.** The allowlist model assumes a credential that
> fits in an env var (an API key or a single token). An agent authenticated by a
> refreshable OAuth token *file* (e.g. a ChatGPT/Codex subscription) does not fit
> this model yet - see the note in the README's "Using codex" section. If your
> agent needs file-based auth, open an issue to discuss before building it.

## Step 3 - the model/effort catalog

`AGENT_MODEL_CATALOG` in `agent-catalog.ts` is the catalog of model ids fixowl
knows about, and the safety-net source of truth. `fixowl init` presents it, the
config schema rejects anything not in it, `fixowl validate` rejects it too, and
your adapter passes the chosen values into the CLI.

Add an entry keyed by your adapter's `name`:

```ts
mycli: {
  models: [
    { id: "mycli-large", description: "Most capable; a good default." },
    { id: "mycli-fast", description: "Cheaper and faster." },
  ],
  efforts: ["low", "medium", "high"],
},
```

The contract:

- `models[].id` is passed verbatim to your CLI's model flag; `description` is the
  one-line note shown during `fixowl init`.
- `efforts` is the valid reasoning-effort levels **in ascending order**. Leave it
  `[]` if the agent has no effort axis - the schema then *rejects* configuring an
  effort for it (see `validateModelEffort`).
- Only agents that expose a model/effort choice belong here. The test-only
  `script` adapter deliberately has **no** catalog entry.

The real model set is often account- or server-specific, so seed a sensible
starting list and note in a comment that operators can extend it with any model
their key can reach (as the `codex` entry does).

If your provider exposes a queryable model list (as OpenAI does via
`GET /v1/models`), you can optionally register a live source in
`packages/core/src/model-list.ts` keyed by your adapter's `name`, mirroring
`getUsageReader` in `agent-usage.ts`: a pure parser plus the injected `fetchJson`
I/O edge. `fixowl validate` then cross-checks each chosen id against the live
list on top of the catalog (fail-open: an unreachable list warns and falls back
to the catalog; a fetched list missing the model hard-fails). Agents with no
queryable list (claude) return `undefined` from `getModelListSource` and
keep relying on the catalog alone.

Also add an `AGENT_BILLING` entry (same file) so the run-budget wizard offers the
right spend cap: `subscription` agents get `usage_budget_percent` (read
out-of-band, `agent-usage.ts`), `api-credit` agents get `total_token_budget`
(measured in-band from the agent's own reported token usage, `agent-spend.ts`).
An unregistered agent defaults to `api-credit`; a subscription agent left out
would be offered the wrong cap. To make `total_token_budget` actually count spend
(rather than abstain fail-open), teach `getSpendMeter` in `agent-spend.ts` to
parse your agent's token-usage output.

## Step 4 - test it with the `script` pattern

Adapters are pure functions, so they test directly - no Docker, no network.
Follow [`packages/core/src/agent-adapters.test.ts`](../packages/core/src/agent-adapters.test.ts)
and [`packages/core/src/agent-catalog.test.ts`](../packages/core/src/agent-catalog.test.ts):

```ts
it("mycli: builds headless argv and appends model/effort when selected", () => {
  const mycli = getAgentAdapter("mycli");
  expect(mycli.argv("fix")).toEqual([
    "mycli", "run", "--prompt-file", PROMPT_MOUNT_PATH, "--non-interactive",
  ]);
  expect(mycli.argv("fix", { model: "mycli-large", effort: "high" })).toEqual([
    "mycli", "run", "--prompt-file", PROMPT_MOUNT_PATH, "--non-interactive",
    "--model", "mycli-large", "--effort", "high",
  ]);
  expect(mycli.promptVia).toBe("file");
  expect(mycli.env).toEqual([]);                       // paid agent: opt-in only
});

it("mycli: an operator opts the key into the allowlist via config override", () => {
  expect(getAgentAdapter("mycli", ["MYCLI_API_KEY"]).env).toEqual(["MYCLI_API_KEY"]);
  expect(getAgentAdapter("mycli").env).toEqual([]);    // default stays empty
});
```

Also update the shared assertions that enumerate every adapter - e.g. the
`agentAdapterNames()` expectation at the end of `agent-adapters.test.ts` - so the
suite still lists the full set.

### Exercising the whole night deterministically

The **`script` adapter** exists precisely so the entire runner - selection,
prompt building, container exec, push, PR, CI-gated loop - can be exercised end
to end with **zero LLM spend**. It extracts the fenced `<untrusted-issue-body>`
from the prompt and runs it as bash, so a test issue body *is* the edit script.
Two harnesses use it, and they are the best way to prove your plumbing works
before spending real tokens on your new agent:

- The in-process night e2e in `packages/action/src/main.test.ts` (real git
  sandbox, fake GitHub/Docker).
- `scripts/local-docker-e2e.ts` (`pnpm e2e:docker`): a real-Docker, fake-GitHub
  run with no network writes.

Your own adapter's logic is fully covered by the pure unit tests above; the
`script` harnesses verify the runner around it. A real end-to-end run with your
actual agent CLI (and a real credential) is the final manual check before you
ship - note in your PR whether you were able to do one.

## Checklist

- [ ] `AgentAdapter` added to `agent-adapters.ts` and registered in `ADAPTERS`.
- [ ] Headless argv, prompt via stdin or `PROMPT_MOUNT_PATH`, model/effort
      appended only when set.
- [ ] `env` allowlist correct (empty default for a paid agent; no GitHub creds).
- [ ] `AGENT_MODEL_CATALOG` entry with models + efforts (or no entry if there is
      no choice to make).
- [ ] Unit tests for argv, `promptVia`, `env`, and the config-override path;
      `agentAdapterNames()` assertion updated.
- [ ] README "Agent-agnostic" bullet and any relevant config docs mention the
      new agent.
- [ ] `pnpm lint` and `pnpm test` pass; `pnpm build` committed if the bundle
      changed.

That's the whole surface. Two files, a handful of tests, and no invariant is at
risk - which is exactly why this is the contribution we most want to see.
