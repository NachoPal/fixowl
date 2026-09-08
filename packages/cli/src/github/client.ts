import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { RuntimeCredential } from "@fixowl/core";

/**
 * Octokit's default logger prints raw request failures ("GET /user - 401 ...")
 * to the console. Every call site here reports failures itself, in terms an
 * operator can act on, so the raw line is noise; silence it.
 */
const QUIET = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

export function githubClient(token: string): Octokit {
  return new Octokit({ auth: token, log: QUIET });
}

/**
 * A GitHub App client for the CLI (used by validate/init to confirm the App
 * identity and its permissions). The same client handles both app-JWT endpoints
 * (`GET /app`, `GET /app/installations/{id}`) and installation-token endpoints;
 * @octokit/auth-app picks the right auth per endpoint. `privateKey` must be a
 * PKCS#8 PEM (normalize with `toPkcs8Pem` first).
 */
export function appClient(cred: RuntimeCredential): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: cred.appId, privateKey: cred.privateKey, installationId: cred.installationId },
    log: QUIET,
  });
}
