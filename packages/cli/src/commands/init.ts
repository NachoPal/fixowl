import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { CONFIG_PATH, FIXOWL_DIR, SECRETS_PATH } from "../config-load.ts";
import { log } from "../log.ts";

const STARTER_CONFIG = `# fixowl configuration. Secrets live in secrets.env next to this file and are
# referenced as \${VAR}; this file never contains raw secrets.
version: 1

github:
  admin_token: \${FIXOWL_ADMIN_TOKEN}      # fine-grained PAT, CLI machine only
  runtime_token: \${FIXOWL_RUNTIME_TOKEN}  # fine-grained PAT, pushed to repos as an Actions secret

# runner:
#   dir: ~/.fixowl/runners   # must live under $HOME (Colima shares $HOME with its VM)

defaults:
  schedule: "37 1 * * *"     # UTC; odd minute dodges GitHub's peak-time cron delays
  labels: { any: [overnight] }
  agent: claude
  max_issues_per_run: 4
  issue_timeout_minutes: 45

# Per-agent env allowlist: the ONLY env vars entering per-issue containers.
agents:
  claude: { env: [CLAUDE_CODE_OAUTH_TOKEN] }

repos:
  - name: your-user/your-repo
    # schedule: "30 1 * * *"   # per-repo override
`;

const STARTER_SECRETS = `# chmod 600. Values referenced from config.yaml as \${VAR}, and agent env vars
# provisioned into repos as Actions secrets are read from here too.
FIXOWL_ADMIN_TOKEN=
FIXOWL_RUNTIME_TOKEN=
CLAUDE_CODE_OAUTH_TOKEN=
`;

export function initCommand(): void {
  mkdirSync(FIXOWL_DIR, { recursive: true });
  if (existsSync(CONFIG_PATH)) {
    log.info(`${CONFIG_PATH} already exists; leaving it alone`);
  } else {
    writeFileSync(CONFIG_PATH, STARTER_CONFIG);
    log.ok(`wrote ${CONFIG_PATH}`);
  }
  if (existsSync(SECRETS_PATH)) {
    log.info(`${SECRETS_PATH} already exists; leaving it alone`);
  } else {
    writeFileSync(SECRETS_PATH, STARTER_SECRETS, { mode: 0o600 });
    log.ok(`wrote ${SECRETS_PATH} (mode 600)`);
  }
  chmodSync(SECRETS_PATH, 0o600);

  log.info(`
Next steps:
  1. Mint two fine-grained PATs at https://github.com/settings/personal-access-tokens,
     scoped to ONLY your target repos:
       admin   - Administration RW, Secrets RW, Contents RW, Workflows RW, Issues RW,
                 Actions RW (stays on this machine)
       runtime - Contents RW, Pull requests RW, Issues RW (becomes a repo Actions secret)
     Put them in ${SECRETS_PATH}.
  2. If using the claude agent: run \`claude setup-token\` and put the resulting
     token in ${SECRETS_PATH} as CLAUDE_CODE_OAUTH_TOKEN.
  3. Edit ${CONFIG_PATH}: list your repos.
  4. Run \`fixowl validate\`, then \`fixowl provision\` and \`fixowl start\`.`);
}
