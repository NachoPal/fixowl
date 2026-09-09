import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalConfigSchema,
  labelsInRule,
  resolveRepoSettings,
  type GlobalConfig,
  type ResolvedRepoSettings,
} from "@fixowl/core";
import type { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { substituteSecretRefs } from "../config-load.ts";
import type { CliContext } from "../context.ts";
import type { Prompter } from "../prompt.ts";
import { applyRepoEditToText, editCommand } from "./edit.ts";
import type { RepoSettingsAnswers } from "./init.ts";
import { provisionCommand } from "./provision.ts";

vi.mock("./provision.ts", () => ({
  provisionCommand: vi.fn(async () => ({ prs: [] })),
}));

const SECRETS = {
  FIXOWL_ADMIN_TOKEN: "admin",
  FIXOWL_APP_PRIVATE_KEY: "base64pem",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
};

/** A hand-authored config with comments, a runner.dir, and a custom per-repo ci_max_tries. */
const HAND_AUTHORED = `# my fixowl config - hand-tuned, please keep these comments
version: 1

github:
  admin_token: \${FIXOWL_ADMIN_TOKEN}      # setup-only PAT
  app:
    app_id: 123456
    installation_id: 7890123
    private_key: \${FIXOWL_APP_PRIVATE_KEY}

runner:
  dir: ~/.custom/runners   # I moved this on purpose

defaults:
  schedule: "37 1 * * *"     # nightly
  labels: { any: [overnight] }
  agent: claude

agents:
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] }

repos:
  - name: NachoPal/storyengine
    ci_max_tries: 7          # this repo needs more CI passes
  - name: NachoPal/other
`;

function loadConfig(text: string): GlobalConfig {
  return globalConfigSchema.parse(substituteSecretRefs(parseYaml(text), SECRETS));
}

/** "Keep everything" answers derived from the repo's current resolved settings. */
function keepAnswers(
  current: ResolvedRepoSettings,
  over: Partial<RepoSettingsAnswers> = {},
): RepoSettingsAnswers {
  return {
    schedule: current.schedule,
    scheduleTrigger: current.scheduleTrigger,
    labels: labelsInRule(current.labels),
    maxIssuesPerRun: current.maxIssuesPerRun,
    usageBudgetPercent: current.usageBudgetPercent,
    runBudgetMinutes: current.runBudgetMinutes,
    issueTimeoutMinutes: current.issueTimeoutMinutes,
    ciMaxTries: current.ciMaxTries,
    ciTimeoutMinutes: current.ciTimeoutMinutes,
    heuristicConflictOrdering: current.heuristicConflictOrdering,
    defaultModel: current.defaultModel,
    defaultEffort: current.defaultEffort,
    labelModels: Object.keys(current.labelModels).length > 0 ? current.labelModels : undefined,
    ...over,
  };
}

function edit(
  text: string,
  repo: string,
  over: Partial<RepoSettingsAnswers>,
): { text: string; changed: boolean } {
  const config = loadConfig(text);
  const current = resolveRepoSettings(config, repo);
  return applyRepoEditToText(text, config, repo, keepAnswers(current, over));
}

describe("applyRepoEditToText - surgical write-back", () => {
  it("edits only the schedule and preserves comments and every other key", () => {
    const { text, changed } = edit(HAND_AUTHORED, "NachoPal/storyengine", {
      schedule: "0 5 * * *",
    });

    expect(changed).toBe(true);
    // The hand-authored comments and the untouched keys survive.
    expect(text).toContain("# my fixowl config - hand-tuned, please keep these comments");
    expect(text).toContain("dir: ~/.custom/runners");
    expect(text).toContain("I moved this on purpose");
    expect(text).toContain("ci_max_tries: 7"); // the repo's custom value is untouched
    expect(text).toContain("this repo needs more CI passes");
    expect(text).toContain("private_key: ${FIXOWL_APP_PRIVATE_KEY}");
    // The one change landed, and the config still loads with it.
    const reloaded = loadConfig(text);
    expect(resolveRepoSettings(reloaded, "NachoPal/storyengine").schedule).toBe("0 5 * * *");
    // The custom ci_max_tries is still in force after the round-trip.
    expect(resolveRepoSettings(reloaded, "NachoPal/storyengine").ciMaxTries).toBe(7);
  });

  it("reports no change and touches nothing when every answer equals the current value", () => {
    const config = loadConfig(HAND_AUTHORED);
    const current = resolveRepoSettings(config, "NachoPal/storyengine");
    const { changed } = applyRepoEditToText(
      HAND_AUTHORED,
      config,
      "NachoPal/storyengine",
      keepAnswers(current),
    );
    expect(changed).toBe(false);
  });

  it("writes a per-repo override when a field changes to a non-default value", () => {
    const { text } = edit(HAND_AUTHORED, "NachoPal/other", { maxIssuesPerRun: 9 });
    const reloaded = loadConfig(text);
    const other = reloaded.repos.find((r) => r.name === "NachoPal/other");
    expect(other?.max_issues_per_run).toBe(9);
  });

  it("drops a redundant per-repo override when a field changes back to the default", () => {
    // storyengine's ci_max_tries (7) differs from the default (3); setting it to
    // the default must remove the per-repo key, not write `ci_max_tries: 3`.
    const { text, changed } = edit(HAND_AUTHORED, "NachoPal/storyengine", { ciMaxTries: 3 });
    expect(changed).toBe(true);
    const reloaded = loadConfig(text);
    const repo = reloaded.repos.find((r) => r.name === "NachoPal/storyengine");
    expect(repo?.ci_max_tries).toBeUndefined();
    // It now resolves to the default via inheritance.
    expect(resolveRepoSettings(reloaded, "NachoPal/storyengine").ciMaxTries).toBe(3);
  });

  it("removes an optional budget key when the answer is blanked (undefined)", () => {
    const withBudget = HAND_AUTHORED.replace(
      "  - name: NachoPal/other\n",
      "  - name: NachoPal/other\n    usage_budget_percent: 70\n",
    );
    const { text } = edit(withBudget, "NachoPal/other", { usageBudgetPercent: undefined });
    const reloaded = loadConfig(text);
    const repo = reloaded.repos.find((r) => r.name === "NachoPal/other");
    expect(repo?.usage_budget_percent).toBeUndefined();
  });

  it("writes label_models on change and clears them when emptied", () => {
    const set = edit(HAND_AUTHORED, "NachoPal/other", {
      labelModels: { heavy: { model: "opus", effort: "max" } },
    });
    const withLabels = loadConfig(set.text);
    expect(withLabels.repos.find((r) => r.name === "NachoPal/other")?.label_models).toEqual({
      heavy: { model: "opus", effort: "max" },
    });

    // Now clear them from that produced text.
    const cleared = edit(set.text, "NachoPal/other", { labelModels: undefined });
    expect(
      loadConfig(cleared.text).repos.find((r) => r.name === "NachoPal/other")?.label_models,
    ).toBeUndefined();
  });

  it("applies a gated agent switch: per-repo agent key plus the agents block", () => {
    const config = loadConfig(HAND_AUTHORED);
    const current = resolveRepoSettings(config, "NachoPal/other");
    const { text, changed } = applyRepoEditToText(
      HAND_AUTHORED,
      config,
      "NachoPal/other",
      keepAnswers(current),
      { agent: "codex", env: ["OPENAI_API_KEY"] },
    );
    expect(changed).toBe(true);
    const reloaded = loadConfig(text);
    expect(reloaded.repos.find((r) => r.name === "NachoPal/other")?.agent).toBe("codex");
    expect(reloaded.agents?.codex).toEqual({ env: ["OPENAI_API_KEY"] });
    // The original agent's block is left intact.
    expect(reloaded.agents?.claude).toEqual({ env: ["CLAUDE_CODE_OAUTH_TOKEN"] });
  });
});

// ---------------------------------------------------------------------------
// editCommand flow
// ---------------------------------------------------------------------------

/** A scripted prompter: `ask` keeps the shown default; `confirm` consumes a queue. */
function scriptedPrompter(confirms: boolean[]): {
  prompter: Prompter;
  provisionAsked: () => boolean;
} {
  const queue = [...confirms];
  let sawProvision = false;
  const prompter = {
    ask: vi.fn(async (_q: string, options?: { default?: string }) => options?.default ?? ""),
    secret: vi.fn(async (_q: string, options?: { existing?: string }) => options?.existing ?? ""),
    confirm: vi.fn(async (question: string) => {
      if (question.includes("Run `fixowl provision`")) sawProvision = true;
      return queue.shift() ?? false;
    }),
    choose: vi.fn(
      async (_q: string, choices: ReadonlyArray<{ value: unknown }>) => choices[0]?.value,
    ),
    multiChoose: vi.fn(async () => []),
    pause: vi.fn(async () => {}),
    say: vi.fn(),
    close: vi.fn(),
  } as unknown as Prompter;
  return { prompter, provisionAsked: () => sawProvision };
}

/** A fake admin whose label listing fails (so fetchLabelCandidates returns []), never hitting the network. */
function fakeAdmin(): Octokit {
  return {
    rest: {
      issues: {
        listLabelsForRepo: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    },
  } as unknown as Octokit;
}

function makeCtx(text: string): CliContext {
  return {
    config: loadConfig(text),
    secrets: { ...SECRETS },
    warnings: [],
    admin: fakeAdmin(),
  };
}

describe("editCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(provisionCommand).mockClear();
  });

  it("errors without an interactive terminal (and no injected prompter)", async () => {
    await expect(editCommand(makeCtx(HAND_AUTHORED), undefined, {})).rejects.toThrow(
      /interactive terminal/,
    );
  });

  it("hands off to provision with noRegister: true when the user opts in", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "fixowl-edit-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, HAND_AUTHORED);
    writeFileSync(
      join(dir, "secrets.env"),
      "FIXOWL_ADMIN_TOKEN=admin\nFIXOWL_APP_PRIVATE_KEY=base64pem\nCLAUDE_CODE_OAUTH_TOKEN=oauth\n",
      { mode: 0o600 },
    );

    // Keep-all for the one repo (agent no, heuristic no, wantsLabels no,
    // setDefault no, edit-another no), then provision yes.
    const { prompter, provisionAsked } = scriptedPrompter([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    await editCommand(makeCtx(HAND_AUTHORED), "NachoPal/storyengine", { configPath, prompter });

    expect(provisionAsked()).toBe(true);
    expect(provisionCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provisionCommand).mock.calls[0]?.[2]).toEqual({ noRegister: true });
  });
});
