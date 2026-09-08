import type { Octokit } from "@octokit/rest";

/**
 * Installation auto-detection for `fixowl init`: once the manifest flow has
 * handed over the App's private key, the CLI can authenticate as the App and
 * list its installations itself instead of sending the user to copy the
 * Installation ID out of a settings URL.
 */

export interface AppInstallation {
  id: number;
  /** The account (user or org) the App is installed on. */
  account: string;
}

/** Lists the App's installations via the App JWT (`GET /app/installations`). */
export async function listAppInstallations(client: Octokit): Promise<AppInstallation[]> {
  const installations = await client.paginate(client.rest.apps.listInstallations, {
    per_page: 100,
  });
  return installations.map((install) => {
    // `account` is a user (login) or an enterprise (name); either names it.
    const account = install.account as { login?: string; name?: string } | null;
    return { id: install.id, account: account?.login ?? account?.name ?? "?" };
  });
}

export type InstallationDetection =
  | { kind: "none" }
  | { kind: "one"; installation: AppInstallation }
  | { kind: "many"; installations: AppInstallation[] };

/**
 * The pure decision on what init does with the listing: nothing installed yet
 * (keep waiting), exactly one (auto-fill it), or several (ask which account).
 */
export function detectInstallation(
  installations: readonly AppInstallation[],
): InstallationDetection {
  if (installations.length === 0) return { kind: "none" };
  const [first, ...rest] = installations;
  if (first !== undefined && rest.length === 0) return { kind: "one", installation: first };
  return { kind: "many", installations: [...installations] };
}
