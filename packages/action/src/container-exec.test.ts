import { getAgentAdapter } from "@fixowl/core";
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

  it("runs as a non-root user with an explicit writable HOME when asked", () => {
    const argv = dockerRunArgv({ ...baseSpec, user: "501:20", homeDir: "/tmp" });
    // --user goes before the mount; HOME is the one env passed by value (not a secret).
    expect(argv).toContain("--user");
    expect(argv[argv.indexOf("--user") + 1]).toBe("501:20");
    expect(argv).toContain("-e");
    expect(argv).toContain("HOME=/tmp");
  });

  it("omits --user and HOME when they are not set (docker default: root)", () => {
    const argv = dockerRunArgv(baseSpec);
    expect(argv).not.toContain("--user");
    expect(argv.join(" ")).not.toContain("HOME=");
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
  // The name format is owned and exhaustively tested in @fixowl/core
  // (container-naming.test.ts); this just guards the re-export the action uses.
  it("is re-exported from core and produces the fixowl-… shape", () => {
    expect(containerName("test/repo", "classify", "claude")).toBe(
      "fixowl-test-repo-classify-claude",
    );
  });
});

describe("DockerEngine.pruneImages", () => {
  it("removes stale images in the repository, keeping the current one", async () => {
    const calls: string[][] = [];
    const exec: Exec = {
      run(argv: readonly string[]): Promise<ExecResult> {
        calls.push([...argv]);
        if (argv[1] === "images") {
          return Promise.resolve(
            ok(
              "fixowl-target:old1\nfixowl-target:current\nfixowl-target:<none>\nfixowl-target:old2\n",
            ),
          );
        }
        return Promise.resolve(ok());
      },
    };
    const engine = new DockerEngine(exec, silentLog);
    await engine.pruneImages("fixowl-target", "fixowl-target:current");
    const removed = calls.filter((argv) => argv[1] === "rmi").map((argv) => argv[2]);
    expect(removed).toEqual(["fixowl-target:old1", "fixowl-target:old2"]);
  });
});

describe("DockerEngine non-root injection", () => {
  it("injects the host uid/gid and HOME into every run so no caller can forget it", async () => {
    let runArgv: string[] = [];
    const exec: Exec = {
      run(argv: readonly string[]): Promise<ExecResult> {
        if (argv[1] === "run") runArgv = [...argv];
        return Promise.resolve(ok());
      },
    };
    const engine = new DockerEngine(exec, silentLog, () => "1001:1001");
    await engine.run(baseSpec);
    expect(runArgv).toContain("--user");
    expect(runArgv[runArgv.indexOf("--user") + 1]).toBe("1001:1001");
    expect(runArgv).toContain("HOME=/tmp");
  });

  it("leaves the run as docker's default when the host uid cannot be resolved", async () => {
    let runArgv: string[] = [];
    const exec: Exec = {
      run(argv: readonly string[]): Promise<ExecResult> {
        if (argv[1] === "run") runArgv = [...argv];
        return Promise.resolve(ok());
      },
    };
    const engine = new DockerEngine(exec, silentLog, () => undefined);
    await engine.run(baseSpec);
    expect(runArgv).not.toContain("--user");
  });
});

// Drives the real codex adapter through the real DockerEngine against a fake
// Exec, so the whole path - argv, the OPENAI_API_KEY allowlist, and the prompt
// on stdin - is exercised without ever invoking the paid codex binary.
async function runCodex(envOverride?: readonly string[], secrets?: Record<string, string>) {
  const adapter = getAgentAdapter("codex", envOverride);
  let runArgv: string[] = [];
  let runOptions: ExecOptions | undefined;
  const exec: Exec = {
    run(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
      if (argv[1] === "run") {
        runArgv = [...argv];
        runOptions = options;
      }
      return Promise.resolve(ok());
    },
  };
  const engine = new DockerEngine(exec, silentLog, () => "501:20");
  await engine.run({
    image: "fixowl-target:abc123",
    argv: adapter.argv("fix", { model: "gpt-5-codex", effort: "high" }),
    name: "fixowl-7-agent",
    workspaceDir: "/work/space",
    env: secrets,
    stdin: "Fix issue #7.",
  });
  return { adapter, runArgv, runOptions };
}

describe("codex adapter end-to-end plumbing (no live codex)", () => {
  it("builds `docker run … codex exec …` with the prompt piped on stdin", async () => {
    const { runArgv, runOptions } = await runCodex(["OPENAI_API_KEY"], {
      OPENAI_API_KEY: "sk-secret",
    });
    const joined = runArgv.join(" ");
    expect(joined).toContain(
      "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --ephemeral -C /workspace -m gpt-5-codex -c model_reasoning_effort=high",
    );
    // The prompt rides stdin, never the argv.
    expect(runArgv).toContain("-i");
    expect(runOptions?.stdin).toBe("Fix issue #7.");
    expect(joined).not.toContain("Fix issue #7.");
  });

  it("passes OPENAI_API_KEY by NAME only when the operator opts it in", async () => {
    const { runArgv } = await runCodex(["OPENAI_API_KEY"], { OPENAI_API_KEY: "sk-secret" });
    expect(runArgv).toContain("-e");
    expect(runArgv).toContain("OPENAI_API_KEY");
    // The secret value never appears in the argv.
    expect(runArgv.join(" ")).not.toContain("sk-secret");
  });

  it("gates the container env: nothing enters unless it is on the allowlist", async () => {
    // Default codex allowlist is empty, so no agent secret is plumbed in.
    const { adapter, runArgv } = await runCodex(undefined, undefined);
    expect(adapter.env).toEqual([]);
    expect(runArgv).not.toContain("OPENAI_API_KEY");
    // A GitHub credential can never be opted in, structurally.
    expect(() => getAgentAdapter("codex", ["GITHUB_TOKEN"])).toThrow(/never holds a GitHub token/);
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
