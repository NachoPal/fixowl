# Host bootstrap (runner machine)

Setting up a pristine machine as the fixowl runner host. Nothing stack-specific
is ever installed on the host: only a Docker-compatible engine and the GitHub
Actions runner infrastructure. Everything else lives in each repo's Docker image.

**Supported hosts.** fixowl ships a self-hosted runner build for **macOS on Apple
Silicon (arm64)**, **macOS on Intel (x64)**, and **Linux x64** - all first-class
(`runnerPlatform` in `packages/cli/src/runner/install.ts`). Only Linux arm64 has
no pinned build; run those (and Windows) on a GitHub-hosted runner instead (see
section 6). This guide is written for macOS; the Linux-x64 steps differ only in
how you install the engine and keep the box awake.

**A note on container architecture (a consideration, not a rule).** fixowl pins
no `--platform` anywhere, so containers follow the host: an Apple Silicon host
builds and runs arm64 images, an Intel or Linux-x64 host amd64. If you want to
match a specific cloud target byte-for-byte you *can* - GitHub now offers both
amd64 and arm64 Linux runners, so "match the cloud" is no longer uniquely amd64,
and an Apple Silicon host can produce amd64 images via emulation (Colima
`--arch x86_64`, or the VZ + Rosetta backend) at a speed cost. Weigh that
trade-off for your repos; nothing in fixowl forces a particular architecture.

## 1. Remote access (do this at the keyboard once)

1. System Settings -> General -> Sharing -> enable Remote Login.
2. Copy your SSH key from the dev machine: `ssh-copy-id user@host`.
3. `xcode-select --install` (pops a one-time GUI dialog; needed by Homebrew).

Everything below works over SSH.

## 2. Homebrew + a Docker engine

fixowl needs any working Docker-compatible engine, not a specific one:
`checkDockerEngine` (`packages/cli/src/docker/engine-check.ts`) prefers Colima
when it is running but otherwise accepts whatever `docker info` succeeds against
- Docker Desktop or a plain Docker daemon are equally fine.

**Colima is the recommended choice for a headless/SSH host** because it is
headless and SSH-friendly (no GUI login session required), which is the usual
shape of a dedicated runner box:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install colima docker node
colima start --cpu 4 --memory 8
brew services start colima   # restart Colima after reboots
docker info                  # sanity check
```

If you prefer **Docker Desktop** or a **plain Docker daemon** (e.g. on a Linux
host), install and start that instead and skip the Colima commands; `docker info`
succeeding is all fixowl checks for. `fixowl provision`/`start` detect the engine
and only set `DOCKER_HOST` when it is Colima.

**A Colima-specific consequence:** Colima shares `$HOME` into its VM, which is why
- *when you run Colima* - the runner directory (default `~/.fixowl/runners`) must
live under `$HOME`: that is what makes `-v $GITHUB_WORKSPACE:/workspace` mounts
resolve inside the VM. On a native Docker daemon (Docker Desktop's file sharing,
or Linux) there is no VM boundary, so this is a Colima detail, not a universal
fixowl requirement.

## 3. Keep-awake

The runner must be online when the schedule fires.

- Keep the machine plugged in, lid open, screen brightness at zero
  (brightness zero only turns off the backlight; it does not sleep the
  machine, and it avoids clamshell-sleep behavior entirely).
- Prevent sleep with one of:
  - `sudo pmset -c disablesleep 1` (note SIP implications), or
  - `brew install --cask keepingyouawake` and enable it, or
  - `caffeinate -dims &` in a login item.
- Confirm a scheduled firing actually happens on this machine before
  trusting it (provision a repo with a cron a few minutes out and watch
  `fixowl status`).

## 4. fixowl

```sh
npm install -g fixowl
# copy ~/.fixowl/ (config.yaml + secrets.env) from your dev machine, then:
fixowl validate
fixowl provision # seals secrets, proposes the workflow via PR (fixowl/provision-workflow),
                 # downloads runners under
                 # ~/.fixowl/runners, and registers them (needs the admin token's
                 # Administration: write)
fixowl start     # installs and starts the runners as launchd services
                 # (reboot-safe via svc.sh); needs no admin token

# or set this host up from scratch: the guided setup asks for the tokens, the
# agent and the repos, then validates, provisions, and offers to start.
fixowl init
```

`fixowl provision` spends the admin token (including its Administration: write,
for runner registration). The **automated night run never uses the admin
token** - it runs purely as the GitHub App. Only `Administration: write` is
genuinely one-time: it is spent for runner registration and nothing needs it
again after, so once the runner is registered you can **drop it** - revoke the
token, or downgrade it to `Administration: read` if you want `fixowl status` to
confirm the runner is online.

The admin PAT's **other write scopes**, though, are needed for every
CLI-driven config change, not just first setup: editing config means re-running
`fixowl provision`, which regenerates the workflow and opens/refreshes a PR
(Contents/Workflows/Pull requests: write, plus Secrets/Issues: write when those
change). So keep the admin PAT (you may strip only Administration: write after
registration) if you plan to keep managing config through the CLI; revoke it
entirely once you are done with CLI config edits, and re-mint it later only when
you want to re-provision. See [docs/security.md](security.md) for the full
breakdown.

If you provision from a different machine than the one that runs the runner,
run `fixowl provision --no-register` there and `fixowl start --register` on the
runner host.

`fixowl start` writes each runner's `.env` with a PATH that covers Homebrew on
Intel (`/usr/local/bin`) and Apple Silicon (`/opt/homebrew/bin`), and - only when
the detected engine is Colima - a `DOCKER_HOST` pointing at the Colima socket. On
a native Docker daemon no `DOCKER_HOST` is written; the default socket is used.

## 5. Verify end to end

From the dev machine:

```sh
fixowl status               # runner should be online
fixowl run owner/repo       # dispatches a night run now and follows it
```

The canary check for a fresh host is a repo whose issue makes the agent run
`docker run --rm -v "$GITHUB_WORKSPACE:/w" alpine ls /w`: it proves the runner,
the container engine, and workspace mounting in one shot.

## 6. Running on a GitHub-hosted (cloud) runner

`fixowl init` asks where the night run executes: a **self-hosted** runner (this
machine, the default and the subject of the sections above) or a **GitHub-hosted**
runner (GitHub's cloud `ubuntu-latest`). The cloud path is turn-key - pick it and
`init` renders the workflow with `runs-on: ubuntu-latest`, defaults the schedule
to GitHub cron, skips runner registration, and starts nothing on your machine -
so onboarding is OS-agnostic: a Windows or arm64 host (where fixowl ships no
self-hosted runner build) can complete `init` on the cloud path, and `init`
steers you there rather than half-provisioning if you pick self-hosted on such a
host. To switch an existing repo, set `runner_mode: github-hosted` (with
`schedule_trigger: github-cron`) in `~/.fixowl/config.yaml` and re-run `fixowl
provision`.

On a GitHub-hosted runner Docker is preinstalled, the action is plain Node, and
the same `docker run` steps just work. Verification runs *inside the container*
(fixowl just executes the commands you declare in `.fixowl.yml`), so ordinary
containerized checks - including a headless browser check you bring in your own
image - run identically on GitHub-hosted Linux runners. The genuinely host-bound
cases you give up on the cloud are narrow: a *literally visible* browser window on
a physical display, real GPU / hardware / physically-attached devices, and
iOS/macOS/Xcode targets. Every container already runs as the host runner's
`--user <uid>:<gid>` (injected in `DockerEngine.run`), so on Linux agent writes to
the mounted workspace stay owned by the runner user and clean up normally; see the
security model's container hardening in [security.md](security.md).
