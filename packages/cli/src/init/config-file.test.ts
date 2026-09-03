import { globalConfigSchema } from "@fixowl/core";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseSecretsEnv, substituteSecretRefs } from "../config-load.ts";
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
  labels: ["overnight"],
  maxIssuesPerRun: 4,
  ...over,
});

const SECRETS = {
  FIXOWL_ADMIN_TOKEN: "admin",
  FIXOWL_RUNTIME_TOKEN: "runtime",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
};

/** Parses rendered YAML the way the CLI does, so the schema is the assertion. */
function loadRendered(yaml: string): ReturnType<typeof globalConfigSchema.parse> {
  return globalConfigSchema.parse(substituteSecretRefs(parseYaml(yaml), SECRETS));
}

describe("renderConfigYaml", () => {
  it("produces a config the loader accepts, with the first repo as defaults", () => {
    const config = loadRendered(
      renderConfigYaml({
        agent: "claude",
        agentEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
        repos: [repo({ scheduleNote: "02:37 Europe/Madrid" })],
      }),
    );
    expect(config.defaults).toMatchObject({
      schedule: "37 1 * * *",
      labels: { any: ["overnight"] },
      agent: "claude",
      max_issues_per_run: 4,
    });
    expect(config.agents).toEqual({ claude: { env: ["CLAUDE_CODE_OAUTH_TOKEN"] } });
    expect(config.repos).toEqual([{ name: "NachoPal/storyengine" }]);
  });

  it("writes per-repo overrides only where a repo differs from the defaults", () => {
    const config = loadRendered(
      renderConfigYaml({
        agent: "claude",
        agentEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
        repos: [
          repo(),
          repo({ name: "NachoPal/same" }),
          repo({
            name: "NachoPal/other",
            schedule: "0 3 * * *",
            labels: ["overnight", "type: bug"],
            maxIssuesPerRun: 1,
          }),
        ],
      }),
    );
    expect(config.repos[1]).toEqual({ name: "NachoPal/same" });
    expect(config.repos[2]).toEqual({
      name: "NachoPal/other",
      schedule: "0 3 * * *",
      labels: { any: ["overnight", "type: bug"] },
      max_issues_per_run: 1,
    });
  });

  it("keeps secrets out of the config file", () => {
    const yaml = renderConfigYaml({
      agent: "claude",
      agentEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
      repos: [repo()],
    });
    expect(yaml).toContain("admin_token: ${FIXOWL_ADMIN_TOKEN}");
    expect(yaml).toContain("runtime_token: ${FIXOWL_RUNTIME_TOKEN}");
    expect(yaml).not.toContain("github_pat_");
  });

  it("refuses to render without a repo", () => {
    expect(() => renderConfigYaml({ agent: "claude", agentEnv: [], repos: [] })).toThrow(
      /at least one repo/,
    );
  });
});

describe("renderSecretsEnv", () => {
  it("round-trips through the secrets parser, tokens first", () => {
    const rendered = renderSecretsEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth",
      FIXOWL_RUNTIME_TOKEN: "github_pat_runtime",
      FIXOWL_ADMIN_TOKEN: "github_pat_admin",
    });
    expect(parseSecretsEnv(rendered)).toEqual({
      FIXOWL_ADMIN_TOKEN: "github_pat_admin",
      FIXOWL_RUNTIME_TOKEN: "github_pat_runtime",
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
