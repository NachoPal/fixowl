import { describe, expect, it } from "vitest";
import { containerName, containerNamePrefix } from "@fixowl/core";
import {
  describeStep,
  logsArgv,
  parsePsOutput,
  psArgv,
  selectContainer,
  toLiveContainers,
  type LiveContainer,
} from "./watch.ts";

const REPO = "acme/widgets";

function live(overrides: Partial<LiveContainer>): LiveContainer {
  return {
    name: containerName(REPO, 7, "agent"),
    repoFullName: REPO,
    issue: 7,
    purpose: "agent",
    status: "Up 2 minutes",
    truncated: false,
    ...overrides,
  };
}

describe("psArgv", () => {
  it("scopes docker ps to one repo's fixowl containers with a tab-separated format", () => {
    expect(psArgv(containerNamePrefix(REPO))).toEqual([
      "docker",
      "ps",
      "--no-trunc",
      "--filter",
      "name=fixowl-acme-widgets-",
      "--format",
      "{{.Names}}\t{{.Status}}",
    ]);
  });
});

describe("logsArgv", () => {
  it("follows by default and can take a one-shot snapshot", () => {
    expect(logsArgv("fixowl-acme-widgets-7-agent", true)).toEqual([
      "docker",
      "logs",
      "-f",
      "fixowl-acme-widgets-7-agent",
    ]);
    expect(logsArgv("fixowl-acme-widgets-7-agent", false)).toEqual([
      "docker",
      "logs",
      "fixowl-acme-widgets-7-agent",
    ]);
  });
});

describe("parsePsOutput", () => {
  it("parses name/status rows and drops blank or malformed lines", () => {
    const stdout = [
      "fixowl-acme-widgets-7-agent\tUp 2 minutes",
      "",
      "   ",
      "no-tab-here",
      "fixowl-acme-widgets-classify-claude\tUp 5 seconds",
    ].join("\n");
    expect(parsePsOutput(stdout)).toEqual([
      { name: "fixowl-acme-widgets-7-agent", status: "Up 2 minutes" },
      { name: "fixowl-acme-widgets-classify-claude", status: "Up 5 seconds" },
    ]);
  });
});

describe("toLiveContainers", () => {
  it("keeps the scoped repos' containers and drops names that do not parse", () => {
    const rows = [
      { name: containerName(REPO, 7, "agent"), status: "Up 2 minutes" },
      { name: containerName(REPO, "classify", "claude"), status: "Up 5 seconds" },
      { name: containerName("other/repo", 9, "agent"), status: "Up 1 minute" },
      { name: "totally-unrelated", status: "Up 1 hour" },
    ];
    const containers = toLiveContainers(rows, [REPO]);
    expect(containers.map((c) => ({ issue: c.issue, purpose: c.purpose }))).toEqual([
      { issue: 7, purpose: "agent" },
      { issue: "classify", purpose: "claude" },
    ]);
  });

  it("de-duplicates a name that surfaces under more than one repo's filter", () => {
    const name = containerName(REPO, 7, "agent");
    const rows = [
      { name, status: "Up 2 minutes" },
      { name, status: "Up 2 minutes" },
    ];
    expect(toLiveContainers(rows, [REPO])).toHaveLength(1);
  });

  it("attributes a prefix-colliding sibling to the longest-matching repo (widgets-2, not widgets)", () => {
    // `docker ps --filter name=fixowl-acme-widgets-` also matches widgets-2's
    // containers; without longest-prefix disambiguation they would be mislabeled
    // as widgets issue 2 ("fixowl-acme-widgets-" stripped leaves "2-7-agent").
    const widgets = "acme/widgets";
    const widgets2 = "acme/widgets-2";
    const sibling = containerName(widgets2, 7, "agent");
    expect(sibling).toBe("fixowl-acme-widgets-2-7-agent");
    const rows = [
      { name: containerName(widgets, 3, "agent"), status: "Up 1 minute" },
      { name: sibling, status: "Up 2 minutes" },
    ];

    const containers = toLiveContainers(rows, [widgets, widgets2]);
    const attributed = containers.find((c) => c.name === sibling);
    expect(attributed).toMatchObject({ repoFullName: widgets2, issue: 7, purpose: "agent" });
    // And crucially it is NOT also attributed to widgets as a bogus issue 2.
    expect(containers.filter((c) => c.name === sibling)).toHaveLength(1);
    expect(containers.some((c) => c.repoFullName === widgets && c.issue === 2)).toBe(false);
  });

  it("still attributes the shorter-prefix repo's own containers correctly", () => {
    const widgets = "acme/widgets";
    const widgets2 = "acme/widgets-2";
    const rows = [{ name: containerName(widgets, 3, "check-lint"), status: "Up 1 minute" }];
    const containers = toLiveContainers(rows, [widgets, widgets2]);
    expect(containers).toMatchObject([{ repoFullName: widgets, issue: 3, purpose: "check-lint" }]);
  });
});

describe("describeStep", () => {
  it("shows the purpose, hints truncation, and labels a clipped-away step", () => {
    expect(describeStep(live({ purpose: "agent" }))).toBe("agent");
    expect(describeStep(live({ purpose: "check-lint", truncated: true }))).toBe("check-lint…");
    expect(describeStep(live({ purpose: "" }))).toBe("(step name clipped)");
  });
});

describe("selectContainer", () => {
  const agent = live({ name: containerName(REPO, 7, "agent"), issue: 7, purpose: "agent" });
  const check = live({
    name: containerName(REPO, 7, "check-lint"),
    issue: 7,
    purpose: "check-lint",
  });
  const classify = live({
    name: containerName(REPO, "classify", "claude"),
    issue: "classify",
    purpose: "claude",
  });

  it("returns none when nothing is running and no flags force a choice", () => {
    expect(selectContainer([], {})).toEqual({ kind: "none" });
  });

  it("streams directly when exactly one is running", () => {
    expect(selectContainer([agent], {})).toEqual({ kind: "one", container: agent });
  });

  it("asks to prompt when several are running", () => {
    expect(selectContainer([agent, check], {})).toEqual({
      kind: "prompt",
      candidates: [agent, check],
    });
  });

  it("--container selects an exact name or reports not-found", () => {
    expect(selectContainer([agent, check], { container: check.name })).toEqual({
      kind: "one",
      container: check,
    });
    expect(selectContainer([agent], { container: "fixowl-acme-widgets-99-agent" })).toEqual({
      kind: "not-found",
      message: 'no live fixowl container named "fixowl-acme-widgets-99-agent"',
    });
  });

  it("--issue narrows to one issue, prompting when it has several steps", () => {
    expect(selectContainer([agent, check, classify], { issue: "7" })).toEqual({
      kind: "prompt",
      candidates: [agent, check],
    });
    expect(selectContainer([agent, classify], { issue: "classify" })).toEqual({
      kind: "one",
      container: classify,
    });
    expect(selectContainer([agent], { issue: "42" })).toEqual({
      kind: "not-found",
      message: 'no live fixowl container for issue "42"',
    });
  });
});
