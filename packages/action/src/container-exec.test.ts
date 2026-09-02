import { describe, expect, it } from "vitest";
import { containerName, DockerEngine, dockerBuildArgv, dockerRunArgv } from "./container-exec.ts";
import type { ContainerRunSpec, Exec, ExecOptions, ExecResult } from "./deps.ts";
import { ok, silentLog } from "./test-helpers.ts";

const baseSpec: ContainerRunSpec = {
  image: "fixowl-target:abc123",
  argv: ["claude", "-p"],
  name: "fixowl-7-agent",
  workspaceDir: "/work/space",
};

describe("dockerRunArgv", () => {
  it("hardens every container the same way", () => {
    const argv = dockerRunArgv(baseSpec);
    expect(argv).toEqual([
      "docker",
      "run",
      "--rm",
      "--name",
      "fixowl-7-agent",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "512",
      "--memory",
      "6g",
      "-v",
      "/work/space:/workspace",
      "-w",
      "/workspace",
      "fixowl-target:abc123",
      "claude",
      "-p",
    ]);
  });

  it("passes env vars by NAME only, never values in argv", () => {
    const argv = dockerRunArgv({
      ...baseSpec,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret" },
    });
    expect(argv).toContain("-e");
    expect(argv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(argv.join(" ")).not.toContain("secret");
  });

  it("mounts the workspace read-only when asked (classification)", () => {
    const argv = dockerRunArgv({ ...baseSpec, workspaceReadOnly: true });
    expect(argv).toContain("/work/space:/workspace:ro");
  });

  it("adds -i only when stdin is provided, and mounts extras with ro flags", () => {
    expect(dockerRunArgv(baseSpec)).not.toContain("-i");
    const argv = dockerRunArgv({
      ...baseSpec,
      stdin: "prompt",
      extraMounts: [{ host: "/tmp/p.md", container: "/fixowl/prompt.md", readOnly: true }],
    });
    expect(argv).toContain("-i");
    expect(argv).toContain("/tmp/p.md:/fixowl/prompt.md:ro");
  });

  it("never mounts the docker socket", () => {
    const argv = dockerRunArgv({
      ...baseSpec,
      extraMounts: [{ host: "/tmp/e", container: "/fixowl/evidence" }],
    });
    expect(argv.join(" ")).not.toContain("docker.sock");
  });
});

describe("dockerBuildArgv", () => {
  it("builds with an explicit dockerfile and context", () => {
    expect(
      dockerBuildArgv({ image: "fixowl-target:abc", dockerfile: "Dockerfile", contextDir: "/ws" }),
    ).toEqual(["docker", "build", "-t", "fixowl-target:abc", "-f", "Dockerfile", "/ws"]);
  });
});

describe("containerName", () => {
  it("sanitizes purposes", () => {
    expect(containerName(7, "check-Client Tests!")).toBe("fixowl-7-check-client-tests");
    expect(containerName("classify", "claude")).toBe("fixowl-classify-claude");
  });
});

describe("DockerEngine timeout", () => {
  it("removes the container by name when the timeout fires", async () => {
    const calls: string[][] = [];
    let resolveRun: ((result: ExecResult) => void) | undefined;
    const exec: Exec = {
      run(argv: readonly string[], _options?: ExecOptions): Promise<ExecResult> {
        calls.push([...argv]);
        if (argv[1] === "rm") {
          // docker rm -f terminates the hung `docker run`
          resolveRun?.({ code: 137, stdout: "", stderr: "killed", timedOut: false });
          return Promise.resolve(ok());
        }
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    };
    const engine = new DockerEngine(exec, silentLog);
    const result = await engine.run({ ...baseSpec, timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(137);
    expect(calls.some((argv) => argv.join(" ") === "docker rm -f fixowl-7-agent")).toBe(true);
  });
});
