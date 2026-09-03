import { Command } from "commander";
import { initCommand } from "./commands/init.ts";
import { logsCommand } from "./commands/logs.ts";
import { provisionCommand } from "./commands/provision.ts";
import { runCommand } from "./commands/run.ts";
import { startCommand } from "./commands/start.ts";
import { statusCommand } from "./commands/status.ts";
import { stopCommand } from "./commands/stop.ts";
import { validateCommand } from "./commands/validate.ts";
import { makeContext } from "./context.ts";
import { log } from "./log.ts";

const program = new Command();

program
  .name("fixowl")
  .description("🦉 The owl that fixes your GitHub issues while you sleep")
  .version("0.1.0")
  .option("-c, --config <path>", "path to config.yaml (default: ~/.fixowl/config.yaml)");

function configPath(): string | undefined {
  return program.opts<{ config?: string }>().config;
}

program
  .command("init")
  .description("guided setup: tokens, agent, repos, then validate, provision, and start")
  .option("--non-interactive", "just scaffold ~/.fixowl and print the manual steps")
  .action(async (options: { nonInteractive?: boolean }) => {
    await initCommand({ configPath: configPath(), nonInteractive: options.nonInteractive });
  });

program
  .command("validate")
  .description("check tokens, repos, docker engine, and agent credentials")
  .action(async () => {
    const ok = await validateCommand(makeContext(configPath()));
    if (!ok) process.exitCode = 1;
  });

program
  .command("provision [repo]")
  .description("create labels, seal secrets, and push the fixowl workflow into target repos")
  .option("--pr", "propose the workflow file via PR instead of pushing to the default branch")
  .option("--no-schedule", "generate the workflow with workflow_dispatch only (no cron)")
  .action(async (repo: string | undefined, options: { pr?: boolean; schedule: boolean }) => {
    await provisionCommand(makeContext(configPath()), repo, {
      pr: options.pr,
      noSchedule: !options.schedule,
    });
  });

program
  .command("start [repo]")
  .description("install, register, and start the self-hosted runner service(s)")
  .action(async (repo: string | undefined) => {
    await startCommand(makeContext(configPath()), repo);
  });

program
  .command("stop [repo]")
  .description("stop the runner service(s); --deregister also removes them from GitHub")
  .option("--deregister", "uninstall the service, deregister from GitHub, and delete the install")
  .action(async (repo: string | undefined, options: { deregister?: boolean }) => {
    await stopCommand(makeContext(configPath()), repo, options);
  });

program
  .command("status [repo]")
  .description("service, runner, last run, and open fixowl PRs per repo")
  .action(async (repo: string | undefined) => {
    await statusCommand(makeContext(configPath()), repo);
  });

program
  .command("run <repo>")
  .description("dispatch the fixowl workflow now and follow it to completion")
  .action(async (repo: string) => {
    await runCommand(makeContext(configPath()), repo);
  });

program
  .command("logs <repo>")
  .description("print the latest fixowl run's logs (--runner for local runner diagnostics)")
  .option("--runner", "print the local runner service diagnostics instead")
  .action(async (repo: string, options: { runner?: boolean }) => {
    await logsCommand(makeContext(configPath()), repo, options);
  });

program.parseAsync().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
