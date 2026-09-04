import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../github/repo-provisioning.ts";
import { getRegistrationToken, runnerNameFor } from "../github/runner-registration.ts";
import { log } from "../log.ts";
import { configureRunner, ensureRunnerInstalled, isRunnerConfigured } from "./install.ts";

/** Side effects registration performs; injectable so the flow is unit-testable. */
export interface RegisterRunnerDeps {
  ensureRunnerInstalled: (dir: string) => Promise<"installed" | "already">;
  isRunnerConfigured: (dir: string) => boolean;
  getRegistrationToken: (admin: Octokit, ref: RepoRef) => Promise<string>;
  configureRunner: (params: {
    dir: string;
    repoFullName: string;
    registrationToken: string;
    runnerName: string;
  }) => Promise<"configured" | "already">;
}

export interface RegisterRunnerParams {
  admin: Octokit;
  ref: RepoRef;
  dir: string;
  repoFullName: string;
  /** Overrides for tests; defaults to the real runner primitives. */
  deps?: Partial<RegisterRunnerDeps>;
}

const defaultDeps: RegisterRunnerDeps = {
  ensureRunnerInstalled,
  isRunnerConfigured,
  getRegistrationToken,
  configureRunner,
};

/**
 * Downloads the runner binary and registers it with GitHub. This is the only
 * step that spends the admin token's **Administration: write**, so it lives on
 * the setup paths (`fixowl provision`, and the explicit `fixowl start
 * --register` for a different host) and never in the routine `fixowl start`
 * flow. Registration is inherently host-specific: it configures the runner on
 * the machine this runs on. Idempotent - a runner already registered in `dir`
 * is left untouched, so re-running provision (or start --register) is safe.
 */
export async function registerRunner(
  params: RegisterRunnerParams,
): Promise<"configured" | "already"> {
  const deps = { ...defaultDeps, ...params.deps };
  const install = await deps.ensureRunnerInstalled(params.dir);
  log.ok(
    install === "installed"
      ? `runner downloaded into ${params.dir}`
      : `runner already installed in ${params.dir}`,
  );

  if (deps.isRunnerConfigured(params.dir)) {
    log.ok("runner already registered");
    return "already";
  }

  const runnerName = runnerNameFor(params.repoFullName);
  const registrationToken = await deps.getRegistrationToken(params.admin, params.ref);
  await deps.configureRunner({
    dir: params.dir,
    repoFullName: params.repoFullName,
    registrationToken,
    runnerName,
  });
  log.ok(`runner registered as ${runnerName} (labels: self-hosted, fixowl)`);
  return "configured";
}
