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
import { version } from "./version.ts";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("fixowl")
    .description("🦉 The owl that fixes your GitHub issues while you sleep")
    .version(version, "-v, --version", "output the version number")
    .option("-c, --config <path>", "path to config.yaml (default: ~/.fixowl/config.yaml)");

  const configPath = (): string | undefined => program.opts<{ config?: string }>().config;

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
    .description(
      "create labels, seal secrets, push the workflow, and register the runner on this host",
    )
    .option("--pr", "propose the workflow file via PR instead of pushing to the default branch")
    .option("--no-schedule", "generate the workflow with workflow_dispatch only (no cron)")
    .option(
      "--no-register",
      "skip runner registration (register on the runner host with `start --register`)",
    )
    .action(
      async (
        repo: string | undefined,
        options: { pr?: boolean; schedule: boolean; register: boolean },
      ) => {
        await provisionCommand(makeContext(configPath()), repo, {
          pr: options.pr,
          noSchedule: !options.schedule,
          noRegister: !options.register,
        });
      },
    );

  program
    .command("start [repo]")
    .description("install and start the self-hosted runner service(s); no admin token needed")
    .option(
      "--register",
      "also register the runner here first (needs admin Administration: write; for a host you didn't provision on)",
    )
    .action(async (repo: string | undefined, options: { register?: boolean }) => {
      await startCommand(makeContext(configPath()), repo, { register: options.register });
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

  return program;
}
