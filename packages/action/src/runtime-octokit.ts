import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { RuntimeCredential } from "@fixowl/core";

/** The subset of Octokit the push-token provider needs: the auth strategy. */
interface AuthCapable {
  auth: (options: { type: "installation" }) => Promise<unknown>;
}

/**
 * Build the night's runtime API client from the resolved credential.
 *
 * - PAT: exactly today's `new Octokit({ auth: token })`.
 * - App: construct with @octokit/auth-app's strategy, which mints an
 *   installation token on first use and transparently re-mints it near its ~1h
 *   expiry on every later REST/GraphQL call. So a multi-hour night never runs on
 *   a dead credential and needs no in-workflow re-mint. No call site in
 *   github-api.ts changes; every existing call now runs against a fresh token.
 */
export function makeRuntimeOctokit(cred: RuntimeCredential): Octokit {
  if (cred.kind === "pat") return new Octokit({ auth: cred.token });
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: cred.appId,
      privateKey: cred.privateKey,
      installationId: cred.installationId,
    },
  });
}

/**
 * The git fetch/push token provider threaded into GitWorkspace (see git-ops.ts).
 *
 * - PAT: a constant callback returning the static token.
 * - App: asks the SAME octokit auth strategy for the current installation token,
 *   which returns the cached token or re-mints a fresh one near expiry. Git and
 *   the API client therefore share one refresh cycle, and a push hours into the
 *   night is authenticated with a live token. The strategy caches in-memory, so
 *   99% of calls return without a network hit. A refresh failure throws (it is
 *   not swallowed), so a push fails loudly rather than pushing unauthenticated.
 */
export function makePushTokenProvider(
  cred: RuntimeCredential,
  octokit: AuthCapable,
): () => Promise<string> {
  if (cred.kind === "pat") {
    const token = cred.token;
    return () => Promise.resolve(token);
  }
  return async () => {
    const auth = (await octokit.auth({ type: "installation" })) as { token: string };
    return auth.token;
  };
}
