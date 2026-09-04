import { describe, expect, it } from "vitest";
import { engineInstallHint } from "./engine-check.ts";

describe("engineInstallHint", () => {
  it("suggests Colima or Docker Desktop on macOS", () => {
    const hint = engineInstallHint("darwin");
    expect(hint).toMatch(/colima/i);
    expect(hint).toMatch(/docker desktop/i);
  });

  it("suggests native Docker on Linux, without macOS-only tools", () => {
    const hint = engineInstallHint("linux");
    expect(hint).toMatch(/docker/i);
    expect(hint).not.toMatch(/colima/i);
    expect(hint).not.toMatch(/docker desktop/i);
  });

  it("gives a generic hint on other platforms", () => {
    const hint = engineInstallHint("win32");
    expect(hint).toMatch(/docker-compatible container engine/i);
    expect(hint).not.toMatch(/colima/i);
    expect(hint).not.toMatch(/brew/i);
  });
});
