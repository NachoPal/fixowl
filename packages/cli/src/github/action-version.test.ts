import { describe, expect, it, vi } from "vitest";
import type { Prompter } from "../prompt.ts";
import { parseActionVersionFlag, promptActionVersion } from "./action-version.ts";

describe("parseActionVersionFlag", () => {
  it("maps `main` (any case) to the moving ref", () => {
    expect(parseActionVersionFlag("main", "0.2.0")).toEqual({ kind: "main" });
    expect(parseActionVersionFlag(" MAIN ", "0.2.0")).toEqual({ kind: "main" });
  });

  it("maps the `cli`/`release`/`default` keywords to this CLI's release", () => {
    for (const keyword of ["cli", "release", "default"]) {
      expect(parseActionVersionFlag(keyword, "0.2.0-rc.10")).toEqual({
        kind: "cli-release",
        cliVersion: "0.2.0-rc.10",
      });
    }
  });

  it("takes anything else as an explicit tag to pin", () => {
    expect(parseActionVersionFlag("v0.2.0-rc.9", "0.2.0")).toEqual({
      kind: "tag",
      tag: "v0.2.0-rc.9",
    });
  });

  it("rejects an empty value with a helpful message", () => {
    expect(() => parseActionVersionFlag("   ", "0.2.0")).toThrow(/needs a value/);
  });
});

/** A prompter whose `choose` returns a queued value and `ask` a queued line. */
function fakePrompter(chooseValue: string, askValue = ""): Prompter {
  return {
    ask: vi.fn(async () => askValue),
    secret: vi.fn(),
    confirm: vi.fn(),
    choose: vi.fn(async () => chooseValue),
    multiChoose: vi.fn(),
    pause: vi.fn(),
    say: vi.fn(),
    close: vi.fn(),
  } as unknown as Prompter;
}

describe("promptActionVersion", () => {
  it("returns the CLI release choice when the operator picks it", async () => {
    const choice = await promptActionVersion(fakePrompter("cli-release"), "0.2.0-rc.10");
    expect(choice).toEqual({ kind: "cli-release", cliVersion: "0.2.0-rc.10" });
  });

  it("returns the moving ref when the operator picks main", async () => {
    const choice = await promptActionVersion(fakePrompter("main"), "0.2.0");
    expect(choice).toEqual({ kind: "main" });
  });

  it("asks for the tag text when the operator picks a specific tag", async () => {
    const choice = await promptActionVersion(fakePrompter("tag", " v0.2.0-rc.9 "), "0.2.0");
    expect(choice).toEqual({ kind: "tag", tag: "v0.2.0-rc.9" });
  });
});
