import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { getAgentAdapter, globalConfigSchema, type ModelListProbe } from "@fixowl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseSecretsEnv } from "../config-load.ts";
import type { EngineStatus } from "../docker/engine-check.ts";
import { SELECTOR_LABEL_META } from "../github/repo-provisioning.ts";
import { renderConfigYaml } from "../init/config-file.ts";
import type { Prompter } from "../prompt.ts";
import {
  AGENT_CHOICES,
  AGENT_SECRET_HELP,
  CLAUDE_AUTH_CHOICES,
  initCommand,
  offerToCreateSelectorLabels,
  promptRepoSettings,
  renderActionsNeeded,
  stepRunnerMode,
  type RepoSettingsPrefill,
} from "./init.ts";
import type { ProvisionResult } from "./provision.ts";

const stubEngine = async (): Promise<EngineStatus> => ({
  ok: true,
  engine: "docker",
  detail: "docker engine (test stub)",
});

describe("fixowl init --non-interactive", () => {
  it("scaffolds a config and a mode-600 secrets file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
    const configPath = join(dir, "config.yaml");
    const secretsPath = join(dir, "secrets.env");

    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });

    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("admin_token: ${FIXOWL_ADMIN_TOKEN}");
    expect(config).toContain("private_key: ${FIXOWL_APP_PRIVATE_KEY}");
    expect(config).not.toContain("runtime_token");
    expect(parseSecretsEnv(readFileSync(secretsPath, "utf8"))).toEqual({
      FIXOWL_ADMIN_TOKEN: "",
      FIXOWL_APP_PRIVATE_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
  });

  it("scaffolds a valid config that defaults to the recommended host scheduler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
    const configPath = join(dir, "config.yaml");

    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });

    // The scaffolded YAML must parse and carry the scheduling-trigger default,
    // resolving the App private_key ref so the schema accepts it.
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (parsed.github as { app: { private_key: string } }).app.private_key = "pem";
    const config = globalConfigSchema.parse(parsed);
    expect(config.defaults?.schedule_trigger).toBe("host-scheduler");
  });

  it("points App setup at the one-click manifest flow, with manual creation as a footnote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
    const configPath = join(dir, "config.yaml");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });
    vi.restoreAllMocks();

    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("one browser click");
    expect(printed).toContain("App Manifest");
    expect(printed).toContain("Manual App setup (advanced)");
    // The old co-equal step-by-step creation guide is gone (Tier-1 lesson:
    // one onboarding path, with manual creation only an advanced footnote).
    expect(printed).not.toContain("https://github.com/settings/apps/new");
    expect(printed).not.toContain('UNCHECK "Active"');
  });

  it("leaves existing files alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
    const configPath = join(dir, "config.yaml");

    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });
    const before = readFileSync(configPath, "utf8");
    await initCommand({ configPath, nonInteractive: true, checkEngine: stubEngine });

    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});

describe("fixowl init agent picker (step 2/4)", () => {
  // The exclusive env allowlist stepAgent resolves for each picker choice:
  // claude asks a sub-choice (subscription vs API key), codex names its key.
  const resolvedEnvs: ReadonlyArray<{ agent: string; env: readonly string[] }> = [
    ...CLAUDE_AUTH_CHOICES.map((c) => ({ agent: "claude", env: [c.value] })),
    ...AGENT_CHOICES.filter((c) => c.env !== undefined).map((c) => ({
      agent: c.value,
      env: [...(c.env ?? [])],
    })),
  ];

  it("carries an env allowlist the core adapter accepts for every choice", () => {
    for (const { agent, env } of resolvedEnvs) {
      // getAgentAdapter throws on an unknown agent or a forbidden env var, so a
      // clean call proves the wizard's choice is a real, safe adapter override.
      const adapter = getAgentAdapter(agent, env);
      expect(adapter.env).toEqual([...env]);
    }
  });

  it("flows each picker choice into a correct agents block in the written config", () => {
    for (const { agent, env } of resolvedEnvs) {
      // Mirror stepAgent: the choice's env is opted into the adapter allowlist,
      // then rendered into config.yaml. Assert on the emitted, parsed config.
      const agentEnv = getAgentAdapter(agent, env).env;
      const yaml = renderConfigYaml({
        agent,
        agentEnv,
        repos: [
          {
            name: "owner/repo",
            schedule: "37 1 * * *",
            scheduleTrigger: "both",
            labels: ["fix"],
            maxIssuesPerRun: 3,
          },
        ],
        app: { appId: "123", installationId: "456" },
      });

      const agentsBlock = yaml.slice(yaml.indexOf("\nagents:\n"));
      expect(agentsBlock).toContain(`${agent}: { env: [${agentEnv.join(", ")}] }`);
    }
  });

  it("provides real credential guidance for every resolvable env var", () => {
    for (const { env } of resolvedEnvs) {
      for (const name of env) {
        expect(AGENT_SECRET_HELP[name], `missing help for ${name}`).toBeTruthy();
      }
    }
  });

  it("offers claude exactly two mutually exclusive auth credentials", () => {
    expect(CLAUDE_AUTH_CHOICES.map((c) => c.value)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
  });
});

const workflowPr = (repo: string, url: string) => ({ repo, kind: "workflow", url }) as const;
const starterPr = (repo: string, url: string) => ({ repo, kind: "starter-files", url }) as const;

describe("fixowl init ACTIONS NEEDED block (end of init)", () => {
  it("names the workflow PR with its full URL and pauses so it can be merged first", () => {
    const result: ProvisionResult = {
      prs: [workflowPr("acme/widgets", "https://github.com/acme/widgets/pull/1")],
    };
    const { block, pause } = renderActionsNeeded(result);

    expect(block).toContain("ACTIONS NEEDED");
    expect(block).toContain("before starting the runner");
    expect(block).toContain("https://github.com/acme/widgets/pull/1");
    expect(block).toContain("acme/widgets");
    // The required workflow PR must gate the start-runner prompt.
    expect(pause).toBe(true);
  });

  it("lists every repo's workflow PR when several repos were provisioned", () => {
    const result: ProvisionResult = {
      prs: [
        workflowPr("acme/widgets", "https://github.com/acme/widgets/pull/1"),
        workflowPr("acme/gadgets", "https://github.com/acme/gadgets/pull/7"),
      ],
    };
    const { block, pause } = renderActionsNeeded(result);

    expect(block).toContain("https://github.com/acme/widgets/pull/1");
    expect(block).toContain("https://github.com/acme/gadgets/pull/7");
    expect(pause).toBe(true);
  });

  it("separates the optional starter-files PR from the required workflow PR", () => {
    const result: ProvisionResult = {
      prs: [
        workflowPr("acme/widgets", "https://github.com/acme/widgets/pull/1"),
        starterPr("acme/widgets", "https://github.com/acme/widgets/pull/2"),
      ],
    };
    const { block, pause } = renderActionsNeeded(result);

    expect(block).toContain("https://github.com/acme/widgets/pull/1");
    expect(block).toContain("https://github.com/acme/widgets/pull/2");
    expect(block).toContain("optional");
    expect(pause).toBe(true);
  });

  it("does not pause when only an optional starter-files PR is open", () => {
    const result: ProvisionResult = {
      prs: [starterPr("acme/widgets", "https://github.com/acme/widgets/pull/2")],
    };
    const { block, pause } = renderActionsNeeded(result);

    expect(block).toContain("https://github.com/acme/widgets/pull/2");
    expect(pause).toBe(false);
  });

  it("degrades gracefully with no empty merge list when there is nothing to merge", () => {
    const { block, pause } = renderActionsNeeded({ prs: [] });

    expect(block).toContain("ACTIONS NEEDED");
    expect(block).toContain("Nothing to merge");
    expect(block).not.toContain("http");
    expect(pause).toBe(false);
  });
});

function scaffoldArgs(): { configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "fixowl-init-"));
  return { configPath: join(dir, "config.yaml") };
}

describe("fixowl init container-engine report", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirms the engine when one is present, without failing", async () => {
    const okSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const present: EngineStatus = { ok: true, engine: "colima", detail: "colima running" };

    await initCommand({
      ...scaffoldArgs(),
      nonInteractive: true,
      checkEngine: async () => present,
    });

    expect(okSpy.mock.calls.flat().join("\n")).toContain("container engine ready");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns non-fatally when no engine is present, pointing at validate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const absent: EngineStatus = {
      ok: false,
      engine: "none",
      detail: "no working docker engine; install Docker and start the daemon",
    };

    // Init must still succeed (write config) rather than throw when no engine.
    await expect(
      initCommand({ ...scaffoldArgs(), nonInteractive: true, checkEngine: async () => absent }),
    ).resolves.toBeUndefined();

    const warned = warnSpy.mock.calls.flat().join("\n");
    expect(warned).toContain("no working docker engine");
    expect(warned).toContain("fixowl start");
    expect(warned).toContain("fixowl validate");
  });
});

interface FakeLabelOctokit {
  octokit: Octokit;
  created: Array<{ name: string; description: string }>;
}

/** A fake admin Octokit recording selector labels created via ensureLabels. */
function fakeLabelOctokit(fail = false): FakeLabelOctokit {
  const created: Array<{ name: string; description: string }> = [];
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const octokit = {
    rest: {
      issues: {
        getLabel: vi.fn(async () => {
          throw notFound;
        }),
        createLabel: vi.fn(async ({ name, description }: { name: string; description: string }) => {
          if (fail) throw new Error("insufficient scope");
          created.push({ name, description });
          return { data: {} };
        }),
      },
    },
  } as unknown as Octokit;
  return { octokit, created };
}

/** A prompter whose confirm always answers `answer`; other calls throw. */
function confirmingPrompter(answer: boolean): { prompter: Prompter; questions: string[] } {
  const questions: string[] = [];
  const prompter = {
    confirm: vi.fn(async (question: string) => {
      questions.push(question);
      return answer;
    }),
  } as unknown as Prompter;
  return { prompter, questions };
}

describe("offerToCreateSelectorLabels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when every chosen label already exists", async () => {
    const { prompter, questions } = confirmingPrompter(true);
    const { octokit, created } = fakeLabelOctokit();

    await offerToCreateSelectorLabels(prompter, octokit, "acme/widgets", ["heavy"], ["heavy"]);

    expect(questions).toEqual([]);
    expect(created).toEqual([]);
  });

  it("offers, then creates the missing labels with the selector metadata on yes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { prompter, questions } = confirmingPrompter(true);
    const { octokit, created } = fakeLabelOctokit();

    await offerToCreateSelectorLabels(
      prompter,
      octokit,
      "acme/widgets",
      ["heavy", "quick"],
      ["quick"],
    );

    expect(questions[0]).toContain("heavy");
    expect(questions[0]).not.toContain("quick");
    expect(created).toEqual([{ name: "heavy", description: SELECTOR_LABEL_META.description }]);
  });

  it("creates nothing when the user declines", async () => {
    const { prompter } = confirmingPrompter(false);
    const { octokit, created } = fakeLabelOctokit();

    await offerToCreateSelectorLabels(prompter, octokit, "acme/widgets", ["heavy"], []);

    expect(created).toEqual([]);
  });

  it("is best-effort: a creation failure warns and does not throw", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prompter } = confirmingPrompter(true);
    const { octokit } = fakeLabelOctokit(true);

    await expect(
      offerToCreateSelectorLabels(prompter, octokit, "acme/widgets", ["heavy"], []),
    ).resolves.toBeUndefined();

    expect(warnSpy.mock.calls.flat().join("\n")).toContain("provision");
  });
});

/**
 * A scripted prompter for the per-repo question block: `ask` answers by question
 * substring, `confirm` always declines, `choose` takes the first option. It
 * records every `ask` so a test can assert which spend-cap prompt was shown.
 */
function repoPromptAnswer(q: string): string {
  if (q.includes("Nightly run time")) return "02:37";
  if (q.includes("Labels that mark")) return "overnight";
  if (q.includes("Token budget")) return "2000000";
  if (q.includes("Usage budget")) return "85";
  if (q.includes("max issues")) return "4";
  if (q.includes("Per-issue timeout")) return "45";
  if (q.includes("max agent passes")) return "3";
  if (q.includes("minutes each pass")) return "60";
  return ""; // graceful run budget and anything else: opt out / default
}

function scriptedRepoPrompter(): { prompter: Prompter; questions: string[] } {
  const questions: string[] = [];
  const prompter = {
    ask: async (question: string) => {
      questions.push(question);
      return repoPromptAnswer(question);
    },
    confirm: async () => false,
    choose: async (_q: string, choices: ReadonlyArray<{ value: unknown }>) => choices[0]?.value,
    multiChoose: async () => [],
    secret: async () => "",
    pause: async () => {},
    say: () => {},
    close: () => {},
  } as unknown as Prompter;
  return { prompter, questions };
}

describe("promptRepoSettings billing-aware spend cap", () => {
  // fetchLabelCandidates tolerates a throwing client (its listLabelsForRepo call
  // is wrapped in try/catch), so a bare stub yields no selector-label candidates.
  const admin = {} as unknown as Octokit;
  const prefill: RepoSettingsPrefill = {
    schedule: "02:37",
    scheduleTrigger: "host-scheduler",
    labels: "overnight",
    maxIssuesPerRun: 4,
    usageBudgetPercent: 85,
    totalTokenBudget: 3_000_000,
    runBudgetMinutes: 240,
    issueTimeoutMinutes: 45,
    ciMaxTries: 3,
    ciTimeoutMinutes: 60,
    heuristicConflictOrdering: false,
  };

  it("offers the total-token budget for an API-credit agent (codex)", async () => {
    const { prompter, questions } = scriptedRepoPrompter();
    const answers = await promptRepoSettings(prompter, admin, "codex", "acme/widgets", prefill);
    expect(questions.some((q) => q.includes("Token budget"))).toBe(true);
    expect(questions.some((q) => q.includes("Usage budget"))).toBe(false);
    expect(answers.totalTokenBudget).toBe(2_000_000);
    expect(answers.usageBudgetPercent).toBeUndefined();
  });

  it("offers the usage-window budget for claude on a subscription token", async () => {
    const { prompter, questions } = scriptedRepoPrompter();
    const answers = await promptRepoSettings(prompter, admin, "claude", "acme/widgets", prefill, [
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(questions.some((q) => q.includes("Usage budget"))).toBe(true);
    expect(questions.some((q) => q.includes("Token budget"))).toBe(false);
    expect(answers.usageBudgetPercent).toBe(85);
    expect(answers.totalTokenBudget).toBeUndefined();
  });

  it("offers the usage-window budget for claude when no env is supplied (name default)", async () => {
    const { prompter, questions } = scriptedRepoPrompter();
    const answers = await promptRepoSettings(prompter, admin, "claude", "acme/widgets", prefill);
    expect(questions.some((q) => q.includes("Usage budget"))).toBe(true);
    expect(answers.usageBudgetPercent).toBe(85);
  });

  it("offers the total-token budget for claude on an API key (api-credit auth)", async () => {
    const { prompter, questions } = scriptedRepoPrompter();
    const answers = await promptRepoSettings(prompter, admin, "claude", "acme/widgets", prefill, [
      "ANTHROPIC_API_KEY",
    ]);
    expect(questions.some((q) => q.includes("Token budget"))).toBe(true);
    expect(questions.some((q) => q.includes("Usage budget"))).toBe(false);
    expect(answers.totalTokenBudget).toBe(2_000_000);
    expect(answers.usageBudgetPercent).toBeUndefined();
  });

  it("offers neither spend cap for the zero-spend script agent", async () => {
    const { prompter, questions } = scriptedRepoPrompter();
    const answers = await promptRepoSettings(prompter, admin, "script", "acme/widgets", prefill);
    expect(questions.some((q) => q.includes("Usage budget") || q.includes("Token budget"))).toBe(
      false,
    );
    expect(answers.usageBudgetPercent).toBeUndefined();
    expect(answers.totalTokenBudget).toBeUndefined();
  });

  it("skips the schedule-trigger prompt and forces github-cron for a github-hosted repo", async () => {
    // A github-hosted runner has no host to dispatch from, so promptRepoSettings
    // must NOT call promptScheduleTrigger and must return github-cron. The choose
    // stub returns the first choice, which for the trigger prompt is host-scheduler
    // - so a github-cron answer proves the prompt was skipped.
    const { prompter } = scriptedRepoPrompter();
    const cloudPrefill: RepoSettingsPrefill = {
      ...prefill,
      runnerMode: "github-hosted",
      scheduleTrigger: "github-cron",
    };
    const answers = await promptRepoSettings(
      prompter,
      admin,
      "claude",
      "acme/widgets",
      cloudPrefill,
    );
    expect(answers.scheduleTrigger).toBe("github-cron");
  });
});

/**
 * A prompter that drives the model picker to the default-model chooser and
 * records the model choices it was offered. `confirm` says yes only to "Set a
 * default model", so no label mapping runs; `choose` records the values shown
 * for the "Default model" question and picks the first.
 */
function modelPickerPrompter(): { prompter: Prompter; modelChoices: () => string[] } {
  let modelChoices: string[] = [];
  const prompter = {
    ask: async (q: string) => repoPromptAnswer(q),
    confirm: async (q: string) => q.includes("Set a default model"),
    choose: async (q: string, choices: ReadonlyArray<{ value: unknown }>) => {
      if (q.includes("Default model")) modelChoices = choices.map((c) => String(c.value));
      return choices[0]?.value;
    },
    multiChoose: async () => [],
    secret: async () => "",
    pause: async () => {},
    say: () => {},
    close: () => {},
  } as unknown as Prompter;
  return { prompter, modelChoices: () => modelChoices };
}

/** A probe serving a fixed OpenAI-shaped `/v1/models` payload; never touches the network. */
function fixedProbe(ids: string[]): ModelListProbe {
  return {
    env: { OPENAI_API_KEY: "sk-test" },
    fetchJson: async () => ({ data: ids.map((id) => ({ id })) }),
  };
}

describe("promptRepoSettings live model picker", () => {
  const admin = {} as unknown as Octokit;
  const prefill: RepoSettingsPrefill = {
    schedule: "02:37",
    scheduleTrigger: "host-scheduler",
    labels: "overnight",
    maxIssuesPerRun: 4,
    usageBudgetPercent: 85,
    totalTokenBudget: 3_000_000,
    runBudgetMinutes: 240,
    issueTimeoutMinutes: 45,
    ciMaxTries: 3,
    ciTimeoutMinutes: 60,
    heuristicConflictOrdering: false,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers codex-family ids from the live list, excluding non-codex OpenAI ids", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { prompter, modelChoices } = modelPickerPrompter();
    const probe = fixedProbe(["gpt-4o", "gpt-5.1-codex", "text-embedding-3-small", "gpt-5-codex"]);
    const answers = await promptRepoSettings(
      prompter,
      admin,
      "codex",
      "acme/widgets",
      prefill,
      ["OPENAI_API_KEY"],
      probe,
    );
    expect(modelChoices()).toEqual(["gpt-5.1-codex", "gpt-5-codex"]);
    expect(modelChoices()).not.toContain("gpt-4o");
    expect(modelChoices()).not.toContain("text-embedding-3-small");
    expect(answers.defaultModel).toBe("gpt-5.1-codex");
  });

  it("falls back to the catalog with a warning when the live list is unreachable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
    const { prompter, modelChoices } = modelPickerPrompter();
    const probe: ModelListProbe = {
      env: { OPENAI_API_KEY: "sk-test" },
      fetchJson: async () => {
        throw new Error("HTTP 503");
      },
    };
    await promptRepoSettings(prompter, admin, "codex", "acme/widgets", prefill, [], probe);
    // The exact codex catalog ids, unchanged.
    expect(modelChoices()).toEqual(["gpt-5-codex", "gpt-5.1-codex", "gpt-5.1-codex-max"]);
    expect(warnings.some((w) => w.includes("built-in catalog"))).toBe(true);
  });

  it("falls back to the catalog when the OpenAI key is absent (no fetch)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prompter, modelChoices } = modelPickerPrompter();
    let fetched = false;
    const probe: ModelListProbe = {
      env: {},
      fetchJson: async () => {
        fetched = true;
        return {};
      },
    };
    await promptRepoSettings(prompter, admin, "codex", "acme/widgets", prefill, [], probe);
    expect(fetched).toBe(false);
    expect(modelChoices()).toEqual(["gpt-5-codex", "gpt-5.1-codex", "gpt-5.1-codex-max"]);
  });

  it("leaves the claude picker catalog-only even with a probe present", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { prompter, modelChoices } = modelPickerPrompter();
    let fetched = false;
    const probe: ModelListProbe = {
      env: { OPENAI_API_KEY: "sk-test" },
      fetchJson: async () => {
        fetched = true;
        return { data: [{ id: "gpt-5-codex" }] };
      },
    };
    await promptRepoSettings(
      prompter,
      admin,
      "claude",
      "acme/widgets",
      prefill,
      ["CLAUDE_CODE_OAUTH_TOKEN"],
      probe,
    );
    expect(fetched).toBe(false); // claude has no live model-list source
    expect(modelChoices()).toEqual(["opus", "sonnet", "haiku", "fable"]);
  });
});

/** A prompter whose `choose` returns the value at `pick`, counting its calls. */
function choosePrompter(pick: number): { prompter: Prompter; calls: () => number } {
  let calls = 0;
  const prompter = {
    choose: async (_q: string, choices: ReadonlyArray<{ value: unknown }>) => {
      calls += 1;
      return choices[pick]?.value;
    },
  } as unknown as Prompter;
  return { prompter, calls: () => calls };
}

describe("stepRunnerMode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the picked mode on a supported platform", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Supported: self-hosted is offered first, so pick 0 returns it.
    expect(await stepRunnerMode(choosePrompter(0).prompter, true)).toBe("self-hosted");
    // Pick 1 returns github-hosted.
    expect(await stepRunnerMode(choosePrompter(1).prompter, true)).toBe("github-hosted");
  });

  it("lets a Windows/arm64 (unsupported) user complete init on the cloud path", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // On an unsupported platform github-hosted is offered FIRST (pick 0), and the
    // choice resolves in a single prompt - no throw, works on any OS.
    const { prompter, calls } = choosePrompter(0);
    expect(await stepRunnerMode(prompter, false)).toBe("github-hosted");
    expect(calls()).toBe(1);
  });

  it("refuses self-hosted on an unsupported platform and re-prompts (fail-fast, no half-provision)", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
    // Unsupported platform, choices reversed so index 1 is self-hosted. First pick
    // self-hosted (refused, re-prompt), then github-hosted at index 0.
    let call = 0;
    const prompter = {
      choose: async (_q: string, choices: ReadonlyArray<{ value: unknown }>) => {
        call += 1;
        // First call: pick self-hosted (last, since choices are reversed); second: github-hosted.
        return call === 1 ? choices[choices.length - 1]?.value : choices[0]?.value;
      },
    } as unknown as Prompter;

    expect(await stepRunnerMode(prompter, false)).toBe("github-hosted");
    expect(call).toBe(2);
    expect(warnings.some((w) => w.includes("Can't set up a self-hosted runner"))).toBe(true);
  });
});
