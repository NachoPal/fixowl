/**
 * GitHub App Manifest flow (one-click App creation for `fixowl init`).
 *
 * The manifest is a JSON description of the App - name, permissions, webhook -
 * form-POSTed to GitHub's create-App page. GitHub shows a pre-filled
 * confirmation page (informed consent: the user reviews and can edit before
 * creating), then redirects back with a one-hour temporary `code` that
 * `POST /app-manifests/{code}/conversions` (no authentication) exchanges for
 * the App id, slug, and private key. This module is pure rendering plus that
 * one fetch-injected exchange call; the localhost redirect catcher lives in
 * `manifest-server.ts` and the wizard wiring in `commands/init.ts`.
 */

/**
 * The manifest `default_permissions`: everything the night run needs, and
 * nothing more. Must stay in lockstep with the checks in `verifyApp` /
 * `fixowl validate` and the reference table in docs/app-auth.md.
 */
export const APP_MANIFEST_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  administration: "read",
} as const;

export interface PermissionRationale {
  /** Manifest `default_permissions` key. */
  key: keyof typeof APP_MANIFEST_PERMISSIONS;
  /** The permission's label as GitHub's UI shows it. */
  label: string;
  access: "read" | "write";
  /** Why fixowl needs exactly this access - the least-privilege justification. */
  why: string;
}

/**
 * One reason per pre-filled permission, shown by the wizard before the browser
 * opens and mirrored in docs/app-auth.md. This is the "rationale, not
 * instructions" reframing: the user (or an org owner approving the install)
 * reads why each grant exists instead of ticking boxes from a checklist.
 */
export const APP_PERMISSION_RATIONALE: readonly PermissionRationale[] = [
  {
    key: "contents",
    label: "Contents",
    access: "write",
    why: "push fix branches (fixowl never merges; no merge API is ever called)",
  },
  {
    key: "pull_requests",
    label: "Pull requests",
    access: "write",
    why: "open one draft PR per issue and flip it to ready when CI is green",
  },
  {
    key: "issues",
    label: "Issues",
    access: "write",
    why: "read the labeled issues and comment results back on them",
  },
  {
    key: "checks",
    label: "Checks",
    access: "read",
    why: "the CI gate reads check runs, so a PR goes ready only when CI is green",
  },
  {
    key: "statuses",
    label: "Commit statuses",
    access: "read",
    why: "legacy commit-status contexts count toward the same CI gate",
  },
  {
    key: "actions",
    label: "Actions",
    access: "read",
    why: "fetch failing CI logs so the agent can fix a red build",
  },
  {
    key: "administration",
    label: "Administration",
    access: "read",
    why: "read which checks branch protection requires (read-only: cannot change settings or register runners)",
  },
] as const;

/** The non-permission rows of the rationale (webhook and the catch-all). */
export const APP_MANIFEST_EXTRAS = [
  {
    label: "Webhook",
    value: "off",
    why: "fixowl polls on its nightly schedule; there is no endpoint to host",
  },
  {
    label: "Everything else",
    value: "no access",
    why: "least privilege; the install itself is where you pick which repos it can touch",
  },
] as const;

/** Renders the whole "what is pre-filled and why" block, one row per line. */
export function renderManifestRationale(indent: string): string {
  const rows = [
    ...APP_PERMISSION_RATIONALE.map((p) => ({ head: `${p.label}: ${p.access}`, why: p.why })),
    ...APP_MANIFEST_EXTRAS.map((e) => ({ head: `${e.label}: ${e.value}`, why: e.why })),
  ];
  const width = Math.max(...rows.map((row) => row.head.length));
  return rows.map((row) => `${indent}${row.head.padEnd(width)}  ${row.why}`).join("\n");
}

/** GitHub caps App names at 34 characters; the user can still edit on the page. */
const APP_NAME_MAX = 34;

/** Suggested App name; must be globally unique, so it carries the user's login. */
export function defaultAppName(login: string): string {
  return `fixowl-${login}`.slice(0, APP_NAME_MAX);
}

export interface AppManifestOptions {
  /** Pre-filled App name (editable on GitHub's confirmation page). */
  name: string;
  /** Homepage URL - required by GitHub, not used functionally. */
  homepageUrl: string;
  /** Where GitHub sends the temporary code after "Create GitHub App". */
  redirectUrl: string;
}

/**
 * The App manifest. `hook_attributes` is deliberately absent: GitHub creates
 * the App with its webhook inactive when the manifest declares none (fixowl
 * polls; there is nothing to deliver). `public: false` keeps the App
 * installable only on the account that owns it.
 */
export function buildAppManifest(options: AppManifestOptions): Record<string, unknown> {
  return {
    name: options.name,
    url: options.homepageUrl,
    public: false,
    default_permissions: APP_MANIFEST_PERMISSIONS,
    redirect_url: options.redirectUrl,
  };
}

/**
 * Where the manifest form POSTs: the personal or org create-App page, carrying
 * the anti-CSRF `state` GitHub echoes back next to the code on the redirect.
 */
export function manifestSubmitUrl(options: { org?: string; state: string }): string {
  const base =
    options.org === undefined
      ? "https://github.com/settings/apps/new"
      : `https://github.com/organizations/${encodeURIComponent(options.org)}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(options.state)}`;
}

/** Escapes a string for embedding inside an HTML attribute or text node. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The page that submits the manifest: GitHub only accepts it as a form POST
 * (parameter `manifest`), so the browser is sent through this trampoline. It
 * auto-submits on load, with a visible button as the no-JavaScript fallback.
 * Served by the localhost capture server in the primary flow and written to a
 * file the user opens themselves in the headless flow.
 */
export function renderManifestFormPage(
  manifest: Record<string, unknown>,
  submitUrl: string,
): string {
  const manifestJson = escapeHtml(JSON.stringify(manifest));
  const action = escapeHtml(submitUrl);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>fixowl - create the GitHub App</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
  <h1>&#129417; fixowl</h1>
  <p>Taking you to GitHub to create the fixowl App. GitHub shows everything
  pre-filled for review before anything is created.</p>
  <form id="manifest-form" action="${action}" method="post">
    <input type="hidden" name="manifest" value="${manifestJson}">
    <button type="submit">Continue to GitHub</button>
  </form>
  <script>document.getElementById("manifest-form").submit();</script>
</body>
</html>
`;
}

/** What the conversion endpoint hands back (the fields fixowl keeps). */
export interface ManifestConversion {
  appId: number;
  slug: string;
  /** The App's private key, a PKCS#1 PEM. Exists nowhere else - persist it. */
  pem: string;
  htmlUrl: string;
}

/**
 * Exchanges the redirect's temporary code for the App credentials.
 * `POST /app-manifests/{code}/conversions` needs no authentication; the code is
 * single-use and expires one hour after GitHub issued it.
 */
export async function exchangeManifestCode(
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<ManifestConversion> {
  const response = await fetchFn(
    `https://api.github.com/app-manifests/${encodeURIComponent(code.trim())}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    const hint =
      response.status === 404
        ? " (the code is single-use and expires after 1 hour; re-run the App step to get a fresh one)"
        : "";
    throw new Error(`GitHub rejected the manifest code: HTTP ${response.status}${hint}`);
  }
  const data = (await response.json()) as {
    id?: number;
    slug?: string;
    pem?: string;
    html_url?: string;
  };
  if (typeof data.id !== "number" || typeof data.pem !== "string" || data.pem === "") {
    throw new Error("GitHub's manifest conversion response is missing the App id or private key");
  }
  return {
    appId: data.id,
    slug: data.slug ?? String(data.id),
    pem: data.pem,
    htmlUrl: data.html_url ?? `https://github.com/settings/apps/${data.slug ?? data.id}`,
  };
}

/** Where the user installs the created App on their repos (a separate step). */
export function appInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/**
 * The headless flow's redirect target. GitHub appends `?code=...&state=...`,
 * so landing the user on their own Apps settings page puts the code in the
 * address bar of a page that is obviously theirs, with no server involved.
 */
export const HEADLESS_REDIRECT_URL = "https://github.com/settings/apps";

/**
 * Pulls the temporary code out of a headless answer: the raw code, or the full
 * redirect URL pasted from the address bar (both are accepted so the user
 * cannot get it wrong). Returns undefined when neither shape matches.
 */
export function extractManifestCode(answer: string): string | undefined {
  const trimmed = answer.trim();
  if (trimmed === "") return undefined;
  if (trimmed.includes("://") || trimmed.includes("?")) {
    try {
      const url = new URL(trimmed.includes("://") ? trimmed : `https://x/${trimmed}`);
      const code = url.searchParams.get("code");
      return code === null || code === "" ? undefined : code;
    } catch {
      return undefined;
    }
  }
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined;
}
