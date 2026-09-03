import { Octokit } from "@octokit/rest";

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
