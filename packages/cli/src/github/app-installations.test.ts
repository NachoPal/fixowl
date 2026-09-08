import { describe, expect, it } from "vitest";
import { detectInstallation, listAppInstallations } from "./app-installations.ts";
import type { Octokit } from "@octokit/rest";

describe("detectInstallation", () => {
  it("reports none when the App has no installations yet (user has not installed it)", () => {
    expect(detectInstallation([])).toEqual({ kind: "none" });
  });

  it("auto-fills the single installation", () => {
    expect(detectInstallation([{ id: 42, account: "octocat" }])).toEqual({
      kind: "one",
      installation: { id: 42, account: "octocat" },
    });
  });

  it("hands back all candidates when several accounts installed the App", () => {
    const installations = [
      { id: 1, account: "octocat" },
      { id: 2, account: "my-org" },
    ];
    expect(detectInstallation(installations)).toEqual({ kind: "many", installations });
  });
});

describe("listAppInstallations", () => {
  it("maps installations to their id and owning account login", async () => {
    const fake = {
      rest: { apps: { listInstallations: {} } },
      paginate: async () => [
        { id: 7, account: { login: "octocat" } },
        { id: 9, account: { name: "Acme Enterprise" } },
        { id: 11, account: null },
      ],
    } as unknown as Octokit;

    await expect(listAppInstallations(fake)).resolves.toEqual([
      { id: 7, account: "octocat" },
      { id: 9, account: "Acme Enterprise" },
      { id: 11, account: "?" },
    ]);
  });
});
