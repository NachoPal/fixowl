import { Command } from "commander";
import { editCommand } from "./commands/edit.ts";
import {
  hostSchedulerCheckCommand,
  hostSchedulerInstallCommand,
  hostSchedulerStatusCommand,
  hostSchedulerUninstallCommand,
} from "./commands/host-scheduler.ts";
import { initCommand } from "./commands/init.ts";
import { logsCommand } from "./commands/logs.ts";
import { provisionCommand } from "./commands/provision.ts";
import { runCommand } from "./commands/run.ts";
import { startCommand } from "./commands/start.ts";
import { statusCommand } from "./commands/status.ts";
import { stopCommand } from "./commands/stop.ts";
import { validateCommand } from "./commands/validate.ts";
import { watchCommand } from "./commands/watch.ts";
import { makeContext } from "./context.ts";
import { parseActionVersionFlag } from "./github/action-version.ts";
import { log } from "./log.ts";
import { createPrompter } from "./prompt.ts";
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
    .command("edit [repo]")
    .description("interactively update an existing repo's config, then optionally re-provision")
    .action(async (repo: string | undefined) => {
      await editCommand(makeContext(configPath()), repo, { configPath: configPath() });
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
      "create labels, seal secrets, propose the workflow via PR, and register the runner on this host",
    )
    .option("--no-schedule", "generate the workflow with workflow_dispatch only (no cron)")
    .option(
      "--no-register",
      "skip runner registration (register on the runner host with `start --register`)",
    )
    .option(
      "--action-version <ref>",
      "pin the workflow's fixowl action to this tag (e.g. v0.2.0-rc.9) or `main` (default: this CLI's release, asked interactively)",
    )
    .action(
      async (
        repo: string | undefined,
        options: { schedule: boolean; register: boolean; actionVersion?: string },
      ) => {
        // The flag skips the prompt; without it, provision asks interactively.
        const actionVersion =
          options.actionVersion !== undefined
            ? parseActionVersionFlag(options.actionVersion, version)
            : undefined;
        const prompter = actionVersion === undefined ? createPrompter() : undefined;
        try {
          await provisionCommand(makeContext(configPath()), repo, {
            noSchedule: !options.schedule,
            noRegister: !options.register,
            actionVersion,
            prompter,
          });
        } finally {
          prompter?.close();
        }
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
    .command("watch [repo]")
    .description("list the live agent containers and stream one's logs in real time")
    .option("--issue <n>", "watch the container(s) for this issue without prompting")
    .option("--container <name>", "watch this exact container by name without prompting")
    .option("--no-follow", "print a one-shot log snapshot instead of streaming live")
    .action(
      async (
        repo: string | undefined,
        options: { issue?: string; container?: string; follow: boolean },
      ) => {
        await watchCommand(makeContext(configPath()), repo, {
          issue: options.issue,
          container: options.container,
          follow: options.follow,
        });
      },
    );

  program
    .command("run <repo>")
    .description("dispatch the fixowl workflow now and follow it to completion")
    .action(async (repo: string) => {
      await runCommand(makeContext(configPath()), repo);
    });

  // The local scheduler command group. Registered on both the canonical
  // `host-scheduler` name and a hidden, deprecated `fallback` alias that warns
  // and points at the new name (kept one release for existing muscle memory and
  // launchd agents that still invoke `fixowl fallback check`).
  const addHostSchedulerCommands = (parent: Command, deprecated: boolean): void => {
    const warn = (): void => {
      if (deprecated) {
        log.warn("`fixowl fallback` is deprecated; use `fixowl host-scheduler` instead");
      }
    };

    parent
      .command("install [repo]")
      .description(
        "install the launchd agent(s) that trigger the night on this host (macOS); migrates a pre-rename agent",
      )
      .action(async (repo: string | undefined) => {
        warn();
        await hostSchedulerInstallCommand(makeContext(configPath()), repo, configPath());
      });

    parent
      .command("uninstall [repo]")
      .description("remove the host scheduler launchd agent(s) from this host")
      .action(async (repo: string | undefined) => {
        warn();
        await hostSchedulerUninstallCommand(makeContext(configPath()), repo);
      });

    parent
      .command("status [repo]")
      .description("show whether the host scheduler is installed and its next fire time")
      .action(async (repo: string | undefined) => {
        warn();
        await hostSchedulerStatusCommand(makeContext(configPath()), repo);
      });

    parent
      .command("check [repo]")
      .description("run the check-then-dispatch now (what the launchd agent invokes)")
      .action(async (repo: string | undefined) => {
        warn();
        await hostSchedulerCheckCommand(makeContext(configPath()), repo);
      });
  };

  const hostScheduler = program
    .command("host-scheduler")
    .description(
      "local scheduler that triggers the night on this host: primary dispatch, or a backup for GitHub's unreliable cron",
    );
  addHostSchedulerCommands(hostScheduler, false);

  const fallbackAlias = program
    .command("fallback", { hidden: true })
    .description("deprecated alias for `host-scheduler`");
  addHostSchedulerCommands(fallbackAlias, true);

  program
    .command("logs <repo>")
    .description("print the latest fixowl run's logs (--runner for local runner diagnostics)")
    .option("--runner", "print the local runner service diagnostics instead")
    .action(async (repo: string, options: { runner?: boolean }) => {
      await logsCommand(makeContext(configPath()), repo, options);
    });

  return program;
}
