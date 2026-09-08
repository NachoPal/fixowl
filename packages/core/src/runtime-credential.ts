import {
  APP_ID_SECRET,
  APP_INSTALLATION_ID_SECRET,
  APP_PRIVATE_KEY_SECRET,
  LEGACY_RUNTIME_TOKEN_SECRET,
} from "./secret-names.ts";

/**
 * A repo's runtime credential - the identity the night run pushes with and
 * calls the GitHub API with: always a GitHub App installation. It carries the
 * durable inputs (`appId`/`privateKey`/`installationId`) rather than a token,
 * because the installation token it mints expires in ~1h and must be re-minted
 * throughout a multi-hour night; that re-minting is @octokit/auth-app's job,
 * driven from these three fields.
 */
export interface RuntimeCredential {
  appId: number;
  privateKey: string;
  installationId: number;
}

const APP_SECRET_NAMES = [APP_ID_SECRET, APP_INSTALLATION_ID_SECRET, APP_PRIVATE_KEY_SECRET];

/**
 * Pure runtime resolution from the action's env bag (the sealed repo Actions
 * secrets, surfaced in `process.env`). The App trio must be complete; a partial
 * trio names exactly which secrets are missing so a half-provisioned repo fails
 * loud instead of minting against an incomplete credential. A workflow that
 * still injects the removed runtime-PAT secret gets a migration error pointing
 * at `fixowl provision` and docs/app-auth.md rather than a bare "no credential".
 */
export function resolveRuntimeCredentialFromEnv(
  env: Record<string, string | undefined>,
): RuntimeCredential {
  const missing = APP_SECRET_NAMES.filter((name) => !isSet(env[name]));
  if (missing.length > 0) {
    const legacyHint = isSet(env[LEGACY_RUNTIME_TOKEN_SECRET])
      ? ` ${LEGACY_RUNTIME_TOKEN_SECRET} (the removed runtime PAT) is set but is no longer a ` +
        "runtime credential: fixowl authenticates the night run only as a GitHub App. " +
        "Re-run `fixowl provision` to seal the App secrets and update the workflow; " +
        "see docs/app-auth.md."
      : "";
    throw new Error(
      `no GitHub App runtime credential in the action env: missing ${missing.join(", ")}.` +
        legacyHint,
    );
  }
  return {
    appId: parseId(env[APP_ID_SECRET] ?? "", APP_ID_SECRET),
    privateKey: env[APP_PRIVATE_KEY_SECRET] ?? "",
    installationId: parseId(env[APP_INSTALLATION_ID_SECRET] ?? "", APP_INSTALLATION_ID_SECRET),
  };
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
