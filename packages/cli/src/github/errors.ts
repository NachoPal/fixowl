/** Turns an Octokit failure into a line an operator can act on. */
export function describeGitHubError(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (status === 401) return "invalid or expired token (HTTP 401)";
    if (status === 403) return "token lacks permission (HTTP 403)";
    if (status === 404) return "not found, or the token cannot see it (HTTP 404)";
  }
  return error instanceof Error ? error.message : String(error);
}
