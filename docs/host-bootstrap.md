# Host bootstrap (runner machine)

Setting up a pristine machine (reference host: Intel MacBook Pro, x86_64) as the
fixowl runner host. Nothing stack-specific is ever installed on the host: only
Docker (via Colima) and the GitHub Actions runner infrastructure. Everything
else lives in each repo's Docker image.

The Intel/x86_64 host matters: it matches GitHub-hosted Linux runners, so the
same images behave identically locally and in the cloud (no arm64/amd64 drift).

## 1. Remote access (do this at the keyboard once)

1. System Settings -> General -> Sharing -> enable Remote Login.
2. Copy your SSH key from the dev machine: `ssh-copy-id user@host`.
3. `xcode-select --install` (pops a one-time GUI dialog; needed by Homebrew).

Everything below works over SSH.

## 2. Homebrew + Colima

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install colima docker node
colima start --cpu 4 --memory 8
brew services start colima   # restart Colima after reboots
docker info                  # sanity check
```

Colima is used instead of Docker Desktop because it is headless and
SSH-friendly. Colima shares `$HOME` into its VM, which is why fixowl requires
the runner directory (default `~/.fixowl/runners`) to live under `$HOME`:
that is what makes `-v $GITHUB_WORKSPACE:/workspace` mounts work.

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
entirely only once you are done with CLI config edits - after that, config
changes go through the manual route below. See [docs/security.md](security.md)
for the full breakdown.

If you provision from a different machine than the one that runs the runner,
run `fixowl provision --no-register` there and `fixowl start --register` on the
runner host.

`fixowl start` writes each runner's `.env` with `DOCKER_HOST` pointing at the
Colima socket and a PATH that covers Homebrew on Intel (`/usr/local/bin`) and
Apple Silicon (`/opt/homebrew/bin`).

**No admin PAT at all:** if you don't want to hand fixowl an admin token, run
`fixowl provision --manual` instead. It makes no API calls against the target
repo - it renders the workflow, `.fixowl.yml`, and issue template with the same
renderers `fixowl provision` uses, writes them to `./fixowl-manual/<repo>/`, and
prints the `gh label create` / `gh secret set` commands and PR steps to run
yourself. This is the recommended setup for security-conscious maintainers; see
[docs/security.md](security.md).

## 5. Verify end to end

From the dev machine:

```sh
fixowl status               # runner should be online
fixowl run owner/repo       # dispatches a night run now and follows it
```

The canary check for a fresh host is a repo whose issue makes the agent run
`docker run --rm -v "$GITHUB_WORKSPACE:/w" alpine ls /w`: it proves the runner,
the Colima engine, and workspace mounting in one shot.

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
the same `docker run` steps just work. Host-bound verification (visible browsers,
iOS/macOS targets) is the only thing you give up. Every container already runs as
the host runner's `--user <uid>:<gid>` (injected in `DockerEngine.run`), so on
Linux agent writes to the mounted workspace stay owned by the runner user and
clean up normally; see the security model's container hardening in
[security.md](security.md).
