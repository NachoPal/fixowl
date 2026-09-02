import { describe, expect, it } from "vitest";
import {
  globalConfigSchema,
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
    });
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

  it("throws for unknown repos", () => {
    const config = globalConfigSchema.parse(minimalConfig);
    expect(() => resolveRepoSettings(config, "NachoPal/other")).toThrow(/not listed/);
  });

  it("resolves the runner dir default", () => {
    expect(runnerBaseDir(globalConfigSchema.parse(minimalConfig))).toBe("~/.fixowl/runners");
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
