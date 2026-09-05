import { describe, expect, it } from "vitest";
import {
  globalConfigSchema,
  globalConfigSchemaChecked,
  repoFileConfigSchema,
  resolveRepoSettings,
  runnerBaseDir,
} from "./config-schema.ts";

const minimalConfig = {
  version: 1,
  github: { admin_token: "ghp_admin", runtime_token: "ghp_runtime" },
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

describe("resolveRepoSettings", () => {
  it("falls back to built-in defaults", () => {
    const config = globalConfigSchema.parse(minimalConfig);
    const settings = resolveRepoSettings(config, "NachoPal/storyengine");
    expect(settings).toEqual({
      name: "NachoPal/storyengine",
      schedule: "37 1 * * *",
      labels: { any: ["overnight"] },
      agent: "claude",
      maxIssuesPerRun: 4,
      issueTimeoutMinutes: 45,
      agentEnv: undefined,
      defaultModel: undefined,
      defaultEffort: undefined,
      labelModels: {},
      heuristicConflictOrdering: false,
    });
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

  it("prefers repo entry over defaults over built-ins", () => {
    const config = globalConfigSchema.parse({
      ...minimalConfig,
      defaults: { schedule: "0 2 * * *", agent: "aider", max_issues_per_run: 9 },
      agents: { aider: { env: ["ANTHROPIC_API_KEY"] } },
      repos: [{ name: "NachoPal/storyengine", schedule: "30 1 * * *" }],
    });
    const settings = resolveRepoSettings(config, "NachoPal/storyengine");
    expect(settings.schedule).toBe("30 1 * * *");
    expect(settings.agent).toBe("aider");
    expect(settings.maxIssuesPerRun).toBe(9);
    expect(settings.agentEnv).toEqual(["ANTHROPIC_API_KEY"]);
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

  it("throws for unknown repos", () => {
    const config = globalConfigSchema.parse(minimalConfig);
    expect(() => resolveRepoSettings(config, "NachoPal/other")).toThrow(/not listed/);
  });

  it("resolves the runner dir default", () => {
    expect(runnerBaseDir(globalConfigSchema.parse(minimalConfig))).toBe("~/.fixowl/runners");
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
    // "max" is a claude effort but not an aider one; the repo uses aider.
    expect(() =>
      globalConfigSchemaChecked.parse({
        ...minimalConfig,
        defaults: { agent: "aider" },
        agents: { aider: { env: ["ANTHROPIC_API_KEY"] } },
        repos: [{ name: "NachoPal/storyengine", model: "opus", effort: "max" }],
      }),
    ).toThrow(/effort .*max.* is not available for agent .*aider/);
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
