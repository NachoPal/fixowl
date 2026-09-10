import { describe, expect, it } from "vitest";
import {
  globalConfigSchema,
  globalConfigSchemaChecked,
  hostSchedulerRole,
  repoFileConfigSchema,
  resolveRepoSettings,
  RUNTIME_TOKEN_REMOVED_MESSAGE,
  runnerBaseDir,
  workflowHasSchedule,
} from "./config-schema.ts";

const app = {
  app_id: 123456,
  installation_id: 7890123,
  private_key: "${FIXOWL_APP_PRIVATE_KEY}",
};

const minimalConfig = {
  version: 1,
  github: { admin_token: "ghp_admin", app },
  repos: [{ name: "NachoPal/storyengine" }],
};

describe("globalConfigSchema", () => {
  it("accepts a minimal config", () => {
    const config = globalConfigSchema.parse(minimalConfig);
    expect(config.repos[0]?.name).toBe("NachoPal/storyengine");
  });

  it("rejects bad repo names, versions, and cron shapes", () => {
    expect(() =>
      globalConfigSchema.parse({ ...minimalConfig, repos: [{ name: "not-a-repo" }] }),
    ).toThrow();
    expect(() => globalConfigSchema.parse({ ...minimalConfig, version: 2 })).toThrow();
    expect(() =>
      globalConfigSchema.parse({
        ...minimalConfig,
        defaults: { schedule: "every night" },
      }),
    ).toThrow();
  });

  it("rejects an empty repo list", () => {
    expect(() => globalConfigSchema.parse({ ...minimalConfig, repos: [] })).toThrow();
  });
});

describe("runtime credential (github.app is the only one)", () => {
  it("accepts an App github block", () => {
    const config = globalConfigSchema.parse(minimalConfig);
    expect(config.github.app.app_id).toBe(123456);
  });

  it("requires the app block", () => {
    expect(() =>
      globalConfigSchema.parse({ ...minimalConfig, github: { admin_token: "ghp_admin" } }),
    ).toThrow();
  });

  it("rejects a legacy runtime_token with a migration message pointing at the App", () => {
    expect(() =>
      globalConfigSchema.parse({
        ...minimalConfig,
        github: { admin_token: "ghp_admin", runtime_token: "ghp_runtime" },
      }),
    ).toThrow(RUNTIME_TOKEN_REMOVED_MESSAGE);
  });

  it("rejects a runtime_token even alongside a valid app block (never silently ignored)", () => {
    expect(() =>
      globalConfigSchema.parse({
        ...minimalConfig,
        github: { admin_token: "ghp_admin", runtime_token: "ghp_runtime", app },
      }),
    ).toThrow(/runtime_token \(the runtime PAT\) was removed[\s\S]*docs\/app-auth\.md/);
  });

  it("keeps the admin and fallback tokens", () => {
    const config = globalConfigSchema.parse({
      ...minimalConfig,
      github: { admin_token: "ghp_admin", app, fallback_token: "ghp_fallback" },
    });
    expect(config.github.admin_token).toBe("ghp_admin");
    expect(config.github.fallback_token).toBe("ghp_fallback");
  });

  it("accepts a numeric-string app_id / installation_id", () => {
    const config = globalConfigSchema.parse({
      ...minimalConfig,
      github: {
        admin_token: "ghp_admin",
        app: { app_id: "123456", installation_id: "7890123", private_key: "pem" },
      },
    });
    expect(config.github.app.app_id).toBe("123456");
  });

  it("lets the App through the agent-aware checked schema", () => {
    expect(() => globalConfigSchemaChecked.parse(minimalConfig)).not.toThrow();
  });
});

describe("resolveRepoSettings", () => {
  it("falls back to built-in defaults", () => {
    const config = globalConfigSchema.parse(minimalConfig);
    const settings = resolveRepoSettings(config, "NachoPal/storyengine");
    expect(settings).toEqual({
      name: "NachoPal/storyengine",
      schedule: "37 1 * * *",
      scheduleTrigger: "both",
      labels: { any: ["overnight"] },
      agent: "claude",
      maxIssuesPerRun: 4,
      usageBudgetPercent: undefined,
      totalTokenBudget: undefined,
      runBudgetMinutes: undefined,
      issueTimeoutMinutes: 45,
      ciMaxTries: 3,
      ciTimeoutMinutes: 60,
      agentEnv: undefined,
      defaultModel: undefined,
      defaultEffort: undefined,
      labelModels: {},
      heuristicConflictOrdering: false,
      skipAlreadyFixed: true,
      skipDuplicates: true,
      verifyBeforeFix: true,
      priority: { labels: [], includeUnlabeled: true },
    });
  });

  it("resolves the priority block: repo > defaults; unset stays off (empty labels)", () => {
    // Unset on both repo and defaults => feature off.
    const base = globalConfigSchema.parse(minimalConfig);
    expect(resolveRepoSettings(base, "NachoPal/storyengine").priority).toEqual({
      labels: [],
      includeUnlabeled: true,
    });

    // A defaults block is inherited whole; include_unlabeled defaults to true.
    const fromDefaults = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { priority: { labels: ["priority: high", "priority: low"] } },
    });
    expect(resolveRepoSettings(fromDefaults, "NachoPal/storyengine").priority).toEqual({
      labels: ["priority: high", "priority: low"],
      includeUnlabeled: true,
    });

    // A per-repo block overrides defaults and can opt out of the unlabeled tier.
    const perRepo = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { priority: { labels: ["priority: high"] } },
      repos: [
        {
          name: "NachoPal/storyengine",
          priority: { labels: ["p0", "p1", "p2"], include_unlabeled: false },
        },
      ],
    });
    expect(resolveRepoSettings(perRepo, "NachoPal/storyengine").priority).toEqual({
      labels: ["p0", "p1", "p2"],
      includeUnlabeled: false,
    });
  });

  it("resolves schedule_trigger: repo > defaults > built-in (both)", () => {
    // Unset resolves to `both`, preserving pre-choice behavior.
    const base = globalConfigSchema.parse(minimalConfig);
    expect(resolveRepoSettings(base, "NachoPal/storyengine").scheduleTrigger).toBe("both");

    // A defaults value is inherited when the repo does not override it.
    const fromDefaults = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { schedule_trigger: "github-cron" },
    });
    expect(resolveRepoSettings(fromDefaults, "NachoPal/storyengine").scheduleTrigger).toBe(
      "github-cron",
    );

    // A per-repo value wins over defaults.
    const repoOverride = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { schedule_trigger: "github-cron" },
      repos: [{ name: "NachoPal/storyengine", schedule_trigger: "host-scheduler" }],
    });
    expect(resolveRepoSettings(repoOverride, "NachoPal/storyengine").scheduleTrigger).toBe(
      "host-scheduler",
    );
  });

  it("rejects an unknown schedule_trigger value", () => {
    expect(() =>
      globalConfigSchema.parse({
        ...minimalConfig,
        defaults: { schedule_trigger: "cron-only" },
      }),
    ).toThrow();
  });

  it("resolves heuristic_conflict_ordering: repo > defaults > built-in (off)", () => {
    // Built-in default is off.
    const base = globalConfigSchema.parse(minimalConfig);
    expect(resolveRepoSettings(base, "NachoPal/storyengine").heuristicConflictOrdering).toBe(false);

    // A defaults value is inherited when the repo does not override it.
    const fromDefaults = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { heuristic_conflict_ordering: true },
    });
    expect(
      resolveRepoSettings(fromDefaults, "NachoPal/storyengine").heuristicConflictOrdering,
    ).toBe(true);

    // A per-repo value wins over the defaults value.
    const repoOverride = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { heuristic_conflict_ordering: true },
      repos: [{ name: "NachoPal/storyengine", heuristic_conflict_ordering: false }],
    });
    expect(
      resolveRepoSettings(repoOverride, "NachoPal/storyengine").heuristicConflictOrdering,
    ).toBe(false);
  });

  it("resolves run-budget fields: repo > defaults, and undefined (opted out) when unset", () => {
    // Unset everywhere: no built-in fallback, so the usage/wall-clock axes opt out.
    const bare = resolveRepoSettings(
      globalConfigSchema.parse(minimalConfig),
      "NachoPal/storyengine",
    );
    expect(bare.usageBudgetPercent).toBeUndefined();
    expect(bare.totalTokenBudget).toBeUndefined();
    expect(bare.runBudgetMinutes).toBeUndefined();

    // Inherited from defaults, then overridden per-repo.
    const config = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: {
        usage_budget_percent: 80,
        run_budget_minutes: 200,
        total_token_budget: 5_000_000,
      },
      repos: [
        { name: "NachoPal/storyengine", usage_budget_percent: 60, total_token_budget: 2_000_000 },
      ],
    });
    const settings = resolveRepoSettings(config, "NachoPal/storyengine");
    expect(settings.usageBudgetPercent).toBe(60); // repo wins
    expect(settings.totalTokenBudget).toBe(2_000_000); // repo wins
    expect(settings.runBudgetMinutes).toBe(200); // inherited from defaults
  });

  it("resolves total_token_budget: repo > defaults, undefined (opted out) when unset", () => {
    const fromDefaults = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { total_token_budget: 4_000_000 },
    });
    expect(resolveRepoSettings(fromDefaults, "NachoPal/storyengine").totalTokenBudget).toBe(
      4_000_000,
    );
  });

  it("rejects a usage_budget_percent outside 0..100", () => {
    expect(() =>
      globalConfigSchema.parse({
        ...minimalConfig,
        repos: [{ name: "NachoPal/storyengine", usage_budget_percent: 150 }],
      }),
    ).toThrow();
  });

  it("prefers repo entry over defaults over built-ins", () => {
    const config = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { schedule: "0 2 * * *", agent: "codex", max_issues_per_run: 9 },
      agents: { codex: { env: ["OPENAI_API_KEY"] } },
      repos: [{ name: "NachoPal/storyengine", schedule: "30 1 * * *" }],
    });
    const settings = resolveRepoSettings(config, "NachoPal/storyengine");
    expect(settings.schedule).toBe("30 1 * * *");
    expect(settings.agent).toBe("codex");
    expect(settings.maxIssuesPerRun).toBe(9);
    expect(settings.agentEnv).toEqual(["OPENAI_API_KEY"]);
  });

  it("resolves default model/effort and per-repo label_models", () => {
    const config = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { model: "sonnet", effort: "medium" },
      repos: [
        {
          name: "NachoPal/storyengine",
          model: "opus",
          label_models: { heavy: { model: "opus", effort: "max" } },
        },
      ],
    });
    const settings = resolveRepoSettings(config, "NachoPal/storyengine");
    expect(settings.defaultModel).toBe("opus"); // repo override wins over defaults
    expect(settings.defaultEffort).toBe("medium"); // inherited from defaults
    expect(settings.labelModels).toEqual({ heavy: { model: "opus", effort: "max" } });
  });

  it("resolves CI-gated-loop settings: repo over defaults over built-ins", () => {
    const config = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { ci_max_tries: 5 },
      repos: [{ name: "NachoPal/storyengine", ci_timeout_minutes: 90 }],
    });
    const settings = resolveRepoSettings(config, "NachoPal/storyengine");
    expect(settings.ciMaxTries).toBe(5); // from defaults
    expect(settings.ciTimeoutMinutes).toBe(90); // per-repo override
  });

  it("throws for unknown repos", () => {
    const config = globalConfigSchema.parse(minimalConfig);
    expect(() => resolveRepoSettings(config, "NachoPal/other")).toThrow(/not listed/);
  });

  it("resolves the runner dir default", () => {
    expect(runnerBaseDir(globalConfigSchema.parse(minimalConfig))).toBe("~/.fixowl/runners");
  });
});

describe("scheduling-trigger helpers", () => {
  it("maps each trigger to its host-scheduler role", () => {
    expect(hostSchedulerRole("github-cron")).toBe("none");
    expect(hostSchedulerRole("host-scheduler")).toBe("primary");
    expect(hostSchedulerRole("both")).toBe("fallback");
  });

  it("includes on.schedule only when the workflow relies on the cron", () => {
    expect(workflowHasSchedule("github-cron")).toBe(true);
    expect(workflowHasSchedule("both")).toBe(true);
    // host-scheduler is dispatch-only: no cron in the workflow.
    expect(workflowHasSchedule("host-scheduler")).toBe(false);
  });
});

describe("globalConfigSchemaChecked (agent-aware model/effort)", () => {
  it("accepts valid claude model/effort choices", () => {
    expect(() =>
      globalConfigSchemaChecked.parse({
        ...minimalConfig,
        defaults: { model: "sonnet", effort: "medium" },
        repos: [
          {
            name: "NachoPal/storyengine",
            label_models: { heavy: { model: "opus", effort: "max" } },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a model that is not in the repo agent's catalog", () => {
    expect(() =>
      globalConfigSchemaChecked.parse({
        ...minimalConfig,
        repos: [{ name: "NachoPal/storyengine", model: "gpt-5" }],
      }),
    ).toThrow(/gpt-5.* is not available for agent/);
  });

  it("rejects an effort that is not in the repo agent's catalog", () => {
    expect(() =>
      globalConfigSchemaChecked.parse({
        ...minimalConfig,
        repos: [
          {
            name: "NachoPal/storyengine",
            label_models: { heavy: { model: "opus", effort: "extreme" } },
          },
        ],
      }),
    ).toThrow(/effort .*extreme.* is not available/);
  });

  it("validates against the agent the repo actually uses", () => {
    // "max" is a claude effort but not a codex one; the repo uses codex.
    expect(() =>
      globalConfigSchemaChecked.parse({
        ...minimalConfig,
        defaults: { agent: "codex" },
        agents: { codex: { env: ["OPENAI_API_KEY"] } },
        repos: [{ name: "NachoPal/storyengine", model: "gpt-5-codex", effort: "max" }],
      }),
    ).toThrow(/effort .*max.* is not available for agent .*codex/);
  });
});

describe("repoFileConfigSchema (.fixowl.yml)", () => {
  it("accepts the storyengine-shaped config", () => {
    const parsed = repoFileConfigSchema.parse({
      version: 1,
      dockerfile: "Dockerfile",
      verify: {
        checks: [{ name: "python-tests", run: "PYTHONPATH=src uv run pytest tests/" }],
        web: [
          {
            name: "game-client",
            start: "cd client && npm run dev",
            url: "http://localhost:5173/?slug=callisto_v2",
          },
        ],
      },
      prompt_extra: "Behavior pins are load-bearing.",
    });
    expect(parsed.verify?.checks?.[0]?.name).toBe("python-tests");
  });

  it("accepts a bare config (verification degrades gracefully)", () => {
    expect(repoFileConfigSchema.parse({ version: 1 })).toEqual({ version: 1 });
  });

  it("rejects unnamed checks", () => {
    expect(() =>
      repoFileConfigSchema.parse({ version: 1, verify: { checks: [{ run: "true" }] } }),
    ).toThrow();
  });
});
