/**
 * Names of the repo Actions secrets fixowl seals and the action reads at
 * runtime. Kept in one leaf module (no imports) so both the workflow template
 * and the runtime-credential resolver can reference them without a circular
 * import.
 */

/**
 * The GitHub App runtime-credential trio - the only runtime credential.
 * Provisioning seals these; the action mints an installation token from them
 * that @octokit/auth-app auto-refreshes near its ~1h expiry across the whole
 * night (see runtime-credential.ts and docs/app-auth.md). The installation
 * token reads Checks, which is what makes the CI-gated fix loop real. Never
 * GITHUB_TOKEN: PRs made with GITHUB_TOKEN do not trigger the target repo's own
 * CI. FIXOWL_APP_PRIVATE_KEY holds the normalized PKCS#8 PEM.
 */
export const APP_ID_SECRET = "FIXOWL_APP_ID";
export const APP_PRIVATE_KEY_SECRET = "FIXOWL_APP_PRIVATE_KEY";
export const APP_INSTALLATION_ID_SECRET = "FIXOWL_APP_INSTALLATION_ID";

/**
 * The secret name the removed runtime-PAT path used. Kept ONLY so a workflow
 * provisioned before the App became the sole runtime credential fails with a
 * migration message instead of an opaque "no credential" error; nothing seals
 * or reads it as a credential.
 */
export const LEGACY_RUNTIME_TOKEN_SECRET = "FIXOWL_GITHUB_TOKEN";
