import {
  APP_ID_SECRET,
  APP_INSTALLATION_ID_SECRET,
  APP_PRIVATE_KEY_SECRET,
  RUNTIME_TOKEN_SECRET,
} from "./secret-names.ts";

/**
 * A repo's runtime credential - the identity the night run pushes with and
 * calls the GitHub API with. Exactly one kind per repo (PAT xor App):
 * provisioning seals only one set of secrets, so the two can never legitimately
 * coexist. The App variant carries the durable inputs (`appId`/`privateKey`/
 * `installationId`) rather than a token, because the installation token it mints
 * expires in ~1h and must be re-minted throughout a multi-hour night; that
 * re-minting is @octokit/auth-app's job, driven from these three fields.
 */
export type RuntimeCredential =
  | { kind: "pat"; token: string }
  | { kind: "app"; appId: number; privateKey: string; installationId: number };

/**
 * Pure runtime selection from the action's env bag (the sealed repo Actions
 * secrets, surfaced in `process.env`). The App path wins when its three secrets
 * are all present; otherwise the single runtime PAT; otherwise throw. Because
 * provisioning seals exactly one set, both-present is a misconfiguration and
 * fails loud rather than silently preferring one. A *partial* App trio is
 * treated as "no App" and falls through to the PAT (or the no-credential error),
 * so a half-provisioned repo never mints against an incomplete credential.
 */
export function resolveRuntimeCredentialFromEnv(
  env: Record<string, string | undefined>,
): RuntimeCredential {
  const appId = env[APP_ID_SECRET];
  const privateKey = env[APP_PRIVATE_KEY_SECRET];
  const installationId = env[APP_INSTALLATION_ID_SECRET];
  const pat = env[RUNTIME_TOKEN_SECRET];
  const hasApp = isSet(appId) && isSet(privateKey) && isSet(installationId);
  const hasPat = isSet(pat);
  if (hasApp && hasPat) {
    throw new Error(
      `both a GitHub App credential (${APP_ID_SECRET}/${APP_PRIVATE_KEY_SECRET}/` +
        `${APP_INSTALLATION_ID_SECRET}) and a runtime PAT (${RUNTIME_TOKEN_SECRET}) are set in ` +
        "the action env; provision exactly one runtime credential",
    );
  }
  if (hasApp) {
    return {
      kind: "app",
      appId: parseId(appId, APP_ID_SECRET),
      privateKey,
      installationId: parseId(installationId, APP_INSTALLATION_ID_SECRET),
    };
  }
  if (hasPat) return { kind: "pat", token: pat };
  throw new Error(
    `no runtime credential in the action env: set ${RUNTIME_TOKEN_SECRET} (PAT tier) or the ` +
      `${APP_ID_SECRET}/${APP_PRIVATE_KEY_SECRET}/${APP_INSTALLATION_ID_SECRET} App secrets`,
  );
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function parseId(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
