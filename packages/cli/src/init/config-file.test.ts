import { globalConfigSchema, resolveRepoSettings } from "@fixowl/core";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseSecretsEnv, substituteSecretRefs } from "../config-load.ts";
import type { RunnerMode } from "@fixowl/core";
import {
  parseLabels,
  parseSchedule,
  renderConfigYaml,
  renderSecretsEnv,
  type RepoAnswers,
} from "./config-file.ts";

const repo = (over: Partial<RepoAnswers> = {}): RepoAnswers => ({
  name: "NachoPal/storyengine",
  schedule: "37 1 * * *",
  scheduleTrigger: "both",
  labels: ["overnight"],
  maxIssuesPerRun: 4,
  ...over,
});

const SECRETS = {
  FIXOWL_ADMIN_TOKEN: "admin",
  FIXOWL_APP_PRIVATE_KEY: "base64pem",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
};

const APP = { appId: "123456", installationId: "7890123" };

/** Parses rendered YAML the way the CLI does, so the schema is the assertion. */
function loadRendered(yaml: string): ReturnType<typeof globalConfigSchema.parse> {
  return globalConfigSchema.parse(substituteSecretRefs(parseYaml(yaml), SECRETS));
}

/** The wizard's answers with the constant parts (agent, App) filled in. */
function answers(repos: RepoAnswers[], over: { fallback?: boolean; runnerMode?: RunnerMode } = {}) {
  return { agent: "claude", agentEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], repos, app: APP, ...over };
}

describe("renderConfigYaml", () => {
  it("produces a config the loader accepts, with the first repo as defaults", () => {
    const config = loadRendered(
      renderConfigYaml(answers([repo({ scheduleNote: "02:37 Europe/Madrid" })])),
    );
    expect(config.defaults).toMatchObject({
      schedule: "37 1 * * *",
      labels: { any: ["overnight"] },
      agent: "claude",
      max_issues_per_run: 4,
      ci_max_tries: 3,
      ci_timeout_minutes: 60,
    });
    expect(config.agents).toEqual({ claude: { env: ["CLAUDE_CODE_OAUTH_TOKEN"] } });
    expect(config.repos).toEqual([{ name: "NachoPal/storyengine" }]);
  });

  it("writes per-repo overrides only where a repo differs from the defaults", () => {
    const config = loadRendered(
      renderConfigYaml(
        answers([
          repo(),
          repo({ name: "NachoPal/same" }),
          repo({
            name: "NachoPal/other",
            schedule: "0 3 * * *",
            labels: ["overnight", "type: bug"],
            maxIssuesPerRun: 1,
          }),
        ]),
      ),
    );
    expect(config.repos[1]).toEqual({ name: "NachoPal/same" });
    expect(config.repos[2]).toEqual({
      name: "NachoPal/other",
      schedule: "0 3 * * *",
      labels: { any: ["overnight", "type: bug"] },
      max_issues_per_run: 1,
    });
  });

  it("renders run-budget defaults when set and per-repo overrides where they differ", () => {
    const yaml = renderConfigYaml(
      answers([
        repo({ usageBudgetPercent: 85, runBudgetMinutes: 240, issueTimeoutMinutes: 45 }),
        repo({ name: "NachoPal/other", usageBudgetPercent: 60, issueTimeoutMinutes: 30 }),
      ]),
    );
    const config = loadRendered(yaml);
    expect(config.defaults).toMatchObject({
      usage_budget_percent: 85,
      run_budget_minutes: 240,
      issue_timeout_minutes: 45,
    });
    // The second repo overrides only the fields that differ from the base.
    expect(config.repos[1]).toEqual({
      name: "NachoPal/other",
      usage_budget_percent: 60,
      issue_timeout_minutes: 30,
    });
  });

  it("leaves the usage/wall-clock axes opted out (commented) when the base repo omits them", () => {
    const yaml = renderConfigYaml(answers([repo()]));
    const config = loadRendered(yaml);
    expect(config.defaults?.usage_budget_percent).toBeUndefined();
    expect(config.defaults?.run_budget_minutes).toBeUndefined();
    // ...but the commented examples are present so the axes are discoverable.
    expect(yaml).toContain("# usage_budget_percent:");
    expect(yaml).toContain("# run_budget_minutes:");
  });

  it("renders default model/effort into defaults and label_models per repo", () => {
    const config = loadRendered(
      renderConfigYaml(
        answers([
          repo({
            defaultModel: "sonnet",
            defaultEffort: "medium",
            labelModels: {
              heavy: { model: "opus", effort: "max" },
              quick: { model: "haiku", effort: "low" },
            },
          }),
        ]),
      ),
    );
    expect(config.defaults).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(config.repos[0]).toEqual({
      name: "NachoPal/storyengine",
      label_models: {
        heavy: { model: "opus", effort: "max" },
        quick: { model: "haiku", effort: "low" },
      },
    });
  });

  it("lifts model/effort into defaults only when every repo shares the same value", () => {
    const config = loadRendered(
      renderConfigYaml(
        answers([
          repo({ defaultModel: "sonnet", defaultEffort: "medium" }),
          repo({ name: "NachoPal/same", defaultModel: "sonnet", defaultEffort: "medium" }),
        ]),
      ),
    );
    expect(config.defaults).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(config.repos[0]).toEqual({ name: "NachoPal/storyengine" });
    expect(config.repos[1]).toEqual({ name: "NachoPal/same" });
    expect(resolveRepoSettings(config, "NachoPal/same")).toMatchObject({
      defaultModel: "sonnet",
      defaultEffort: "medium",
    });
  });

  it("renders model/effort per repo when the repos disagree", () => {
    const config = loadRendered(
      renderConfigYaml(
        answers([
          repo({ defaultModel: "sonnet", defaultEffort: "medium" }),
          repo({ name: "NachoPal/big", defaultModel: "opus", defaultEffort: "max" }),
        ]),
      ),
    );
    expect(config.defaults?.model).toBeUndefined();
    expect(config.defaults?.effort).toBeUndefined();
    expect(config.repos[0]).toEqual({
      name: "NachoPal/storyengine",
      model: "sonnet",
      effort: "medium",
    });
    expect(config.repos[1]).toEqual({ name: "NachoPal/big", model: "opus", effort: "max" });
  });

  it("lets a repo decline a default without inheriting another repo's model", () => {
    const config = loadRendered(
      renderConfigYaml(
        answers([
          repo({ defaultModel: "opus", defaultEffort: "max" }),
          repo({ name: "NachoPal/default-agent" }),
        ]),
      ),
    );
    expect(config.defaults?.model).toBeUndefined();
    expect(config.defaults?.effort).toBeUndefined();
    expect(config.repos[1]).toEqual({ name: "NachoPal/default-agent" });
    expect(resolveRepoSettings(config, "NachoPal/default-agent")).toMatchObject({
      defaultModel: undefined,
      defaultEffort: undefined,
    });
    expect(resolveRepoSettings(config, "NachoPal/storyengine")).toMatchObject({
      defaultModel: "opus",
      defaultEffort: "max",
    });
  });

  it("keeps secrets out of the config file", () => {
    const yaml = renderConfigYaml(answers([repo()]));
    expect(yaml).toContain("admin_token: ${FIXOWL_ADMIN_TOKEN}");
    expect(yaml).toContain("private_key: ${FIXOWL_APP_PRIVATE_KEY}");
    expect(yaml).not.toContain("github_pat_");
    expect(yaml).not.toContain("base64pem");
  });

  it("refuses to render without a repo", () => {
    expect(() => renderConfigYaml(answers([]))).toThrow(/at least one repo/);
  });

  it("renders the GitHub App block as the only runtime credential", () => {
    const yaml = renderConfigYaml(answers([repo()]));
    expect(yaml).toContain("app_id: 123456");
    expect(yaml).toContain("installation_id: 7890123");
    expect(yaml).toContain("private_key: ${FIXOWL_APP_PRIVATE_KEY}");
    expect(yaml).not.toContain("runtime_token");
    const config = loadRendered(yaml);
    expect(config.github.app).toEqual({
      app_id: 123456,
      installation_id: 7890123,
      private_key: "base64pem",
    });
  });

  it("renders schedule_trigger into defaults and overrides only where a repo differs", () => {
    const yaml = renderConfigYaml(
      answers([
        repo({ scheduleTrigger: "host-scheduler" }),
        repo({ name: "NachoPal/same", scheduleTrigger: "host-scheduler" }),
        repo({ name: "NachoPal/cron", scheduleTrigger: "github-cron" }),
      ]),
    );
    const config = loadRendered(yaml);
    expect(config.defaults?.schedule_trigger).toBe("host-scheduler");
    // A repo matching the default emits no override; a differing one does.
    expect(config.repos[1]).toEqual({ name: "NachoPal/same" });
    expect(config.repos[2]).toEqual({
      name: "NachoPal/cron",
      schedule_trigger: "github-cron",
    });
    expect(resolveRepoSettings(config, "NachoPal/same").scheduleTrigger).toBe("host-scheduler");
    expect(resolveRepoSettings(config, "NachoPal/cron").scheduleTrigger).toBe("github-cron");
  });

  it("is byte-identical whether default ci/heuristic answers are supplied or omitted", () => {
    // init now collects ci_max_tries / ci_timeout_minutes / heuristic, but when
    // the user keeps the defaults the rendered file must be exactly what the
    // pre-change renderer produced (which had no such fields on RepoAnswers).
    const withoutNewFields = renderConfigYaml(answers([repo()]));
    const withDefaultAnswers = renderConfigYaml(
      answers([repo({ ciMaxTries: 3, ciTimeoutMinutes: 60, heuristicConflictOrdering: false })]),
    );
    expect(withDefaultAnswers).toBe(withoutNewFields);
    // And the defaults block still carries the built-in ci values and the
    // discoverable (commented) heuristic example.
    expect(withoutNewFields).toContain("ci_max_tries: 3");
    expect(withoutNewFields).toContain("ci_timeout_minutes: 60");
    expect(withoutNewFields).toContain("# heuristic_conflict_ordering: true");
  });

  it("renders custom ci values into defaults and per-repo ci overrides where they differ", () => {
    const yaml = renderConfigYaml(
      answers([
        repo({ ciMaxTries: 5, ciTimeoutMinutes: 90 }),
        repo({ name: "NachoPal/other", ciMaxTries: 2, ciTimeoutMinutes: 90 }),
      ]),
    );
    const config = loadRendered(yaml);
    expect(config.defaults).toMatchObject({ ci_max_tries: 5, ci_timeout_minutes: 90 });
    // The second repo overrides only ci_max_tries (its timeout matches the base).
    expect(config.repos[1]).toEqual({ name: "NachoPal/other", ci_max_tries: 2 });
  });

  it("renders heuristic_conflict_ordering as an active default and a per-repo override", () => {
    const yaml = renderConfigYaml(
      answers([
        repo({ heuristicConflictOrdering: true }),
        repo({ name: "NachoPal/off", heuristicConflictOrdering: false }),
      ]),
    );
    const config = loadRendered(yaml);
    expect(config.defaults?.heuristic_conflict_ordering).toBe(true);
    expect(config.repos[1]).toEqual({ name: "NachoPal/off", heuristic_conflict_ordering: false });
    expect(resolveRepoSettings(config, "NachoPal/storyengine").heuristicConflictOrdering).toBe(
      true,
    );
    expect(resolveRepoSettings(config, "NachoPal/off").heuristicConflictOrdering).toBe(false);
  });

  it("omits the fallback token unless the fallback is enabled", () => {
    expect(renderConfigYaml(answers([repo()]))).not.toContain("fallback_token");
  });

  it("wires the fallback token into the github block when enabled", () => {
    const yaml = renderConfigYaml(answers([repo()], { fallback: true }));
    expect(yaml).toContain("fallback_token: ${FIXOWL_FALLBACK_TOKEN}");
    const config = globalConfigSchema.parse(
      substituteSecretRefs(parseYaml(yaml), { ...SECRETS, FIXOWL_FALLBACK_TOKEN: "fb" }),
    );
    expect(config.github.fallback_token).toBe("fb");
  });

  it("omits runner_mode for the self-hosted default (byte-for-byte unchanged)", () => {
    // No runnerMode, and an explicit self-hosted, both leave the config as before.
    expect(renderConfigYaml(answers([repo()]))).not.toContain("runner_mode");
    expect(renderConfigYaml(answers([repo()], { runnerMode: "self-hosted" }))).not.toContain(
      "runner_mode",
    );
  });

  it("writes defaults.runner_mode for the GitHub-hosted (cloud) path", () => {
    const yaml = renderConfigYaml(
      answers([repo({ scheduleTrigger: "github-cron" })], { runnerMode: "github-hosted" }),
    );
    expect(yaml).toContain("runner_mode: github-hosted");
    const config = loadRendered(yaml);
    expect(config.defaults?.runner_mode).toBe("github-hosted");
    expect(resolveRepoSettings(config, "NachoPal/storyengine").runnerMode).toBe("github-hosted");
  });
});

describe("renderSecretsEnv", () => {
  it("round-trips through the secrets parser, tokens first", () => {
    const rendered = renderSecretsEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth",
      FIXOWL_APP_PRIVATE_KEY: "base64pem",
      FIXOWL_ADMIN_TOKEN: "github_pat_admin",
    });
    expect(parseSecretsEnv(rendered)).toEqual({
      FIXOWL_ADMIN_TOKEN: "github_pat_admin",
      FIXOWL_APP_PRIVATE_KEY: "base64pem",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth",
    });
    expect(rendered.indexOf("FIXOWL_ADMIN_TOKEN")).toBeLessThan(
      rendered.indexOf("CLAUDE_CODE_OAUTH_TOKEN"),
    );
  });
});

describe("parseSchedule", () => {
  const reference = new Date("2026-01-15T12:00:00Z");

  it("converts a local time to a UTC cron", () => {
    const local = new Date(reference);
    local.setHours(2, 37, 0, 0);
    expect(parseSchedule("02:37", { reference, timeZone: "Zone/Test" })).toEqual({
      cron: `${local.getUTCMinutes()} ${local.getUTCHours()} * * *`,
      note: "02:37 Zone/Test",
    });
  });

  it("passes a 5-field cron through as UTC", () => {
    expect(parseSchedule(" 37 1 * * * ")).toEqual({ cron: "37 1 * * *" });
  });

  it("rejects anything else", () => {
    expect(() => parseSchedule("tonight")).toThrow(/5-field UTC cron/);
    expect(() => parseSchedule("25:00")).toThrow(/0-23/);
    expect(() => parseSchedule("1 2 3")).toThrow(/5-field UTC cron/);
  });
});

describe("parseLabels", () => {
  it("splits, trims, and de-duplicates", () => {
    expect(parseLabels(" overnight , type: bug ,, overnight ")).toEqual(["overnight", "type: bug"]);
    expect(parseLabels(" , ")).toEqual([]);
  });
});
