/**
 * Names of the repo Actions secrets fixowl seals and the action reads at
 * runtime. Kept in one leaf module (no imports) so both the workflow template
 * and the runtime-credential resolver can reference them without a circular
 * import.
 */

/**
 * The runtime PAT secret (Tier 1, the quick-start credential). Never
 * GITHUB_TOKEN: PRs made with GITHUB_TOKEN do not trigger the target repo's own
 * CI, and a fine-grained PAT cannot read check-run status, so the CI gate
 * degrades on it (see docs/ci-fix-loop.md).
 */
export const RUNTIME_TOKEN_SECRET = "FIXOWL_GITHUB_TOKEN";

/**
 * The GitHub App runtime-credential trio (Tier 2, the real CI-gating
 * credential). Provisioning seals these instead of RUNTIME_TOKEN_SECRET; the
 * action mints an installation token from them that @octokit/auth-app
 * auto-refreshes near its ~1h expiry across the whole night (see
 * runtime-credential.ts and docs/app-auth.md). FIXOWL_APP_PRIVATE_KEY holds the
 * normalized PKCS#8 PEM.
 */
export const APP_ID_SECRET = "FIXOWL_APP_ID";
export const APP_PRIVATE_KEY_SECRET = "FIXOWL_APP_PRIVATE_KEY";
export const APP_INSTALLATION_ID_SECRET = "FIXOWL_APP_INSTALLATION_ID";
