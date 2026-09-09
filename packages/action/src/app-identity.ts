import { FIXOWL_DEFAULT_GIT_IDENTITY, type GitIdentity } from "@fixowl/core";
import type { Logger } from "./deps.ts";

/**
 * The minimal Octokit surface needed to resolve the installed App's bot identity.
 * `apps.getAuthenticated` (GET /app) is authenticated as the App (JWT) - the
 * @octokit/auth-app strategy the runtime octokit is built with selects the JWT
 * for that app-level route automatically (same as CLI validate). `users.getByUsername`
 * (GET /users/<login>) is a public read needing no special auth. Neither requires
 * any new permission scope on the runtime credential.
 */
export interface AppIdentityOctokit {
  apps: { getAuthenticated: () => Promise<{ data: { slug?: string | null } | null }> };
  users: { getByUsername: (params: { username: string }) => Promise<{ data: { id: number } }> };
}

/**
 * Resolve the real GitHub App bot commit identity of the installed App, so
 * host-side commits are authored/committed as `<app-slug>[bot]` with the App's
 * canonical no-reply email and therefore render with the App's name and avatar
 * (the same bot account that already authors the PR and comments).
 *
 * GitHub attributes a commit to an App's bot account when the author email is
 * the bot user's canonical no-reply address:
 *   name:  <app-slug>[bot]
 *   email: <bot-user-numeric-id>+<app-slug>[bot]@users.noreply.github.com
 * Both the slug and the numeric id are per-App and must be resolved live, never
 * hardcoded.
 *
 * Best-effort: this is cosmetic attribution only. A network/read failure warns
 * and falls back to a stable default identity rather than aborting the night -
 * commits still land, just under the legacy fixowl identity, which
 * `isFixowlBranchTip` still recognizes.
 */
export async function resolveAppBotIdentity(
  octokit: AppIdentityOctokit,
  log: Logger,
): Promise<GitIdentity> {
  try {
    const { data: app } = await octokit.apps.getAuthenticated();
    const slug = app?.slug;
    if (slug === undefined || slug === null || slug === "") {
      throw new Error("GET /app returned no app slug");
    }
    const login = `${slug}[bot]`;
    const { data: user } = await octokit.users.getByUsername({ username: login });
    if (typeof user?.id !== "number") {
      throw new Error(`GET /users/${login} returned no numeric id`);
    }
    return { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
  } catch (error) {
    log.warn(
      `could not resolve the App bot commit identity; falling back to ` +
        `${FIXOWL_DEFAULT_GIT_IDENTITY.name} <${FIXOWL_DEFAULT_GIT_IDENTITY.email}>: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return FIXOWL_DEFAULT_GIT_IDENTITY;
  }
}
