import { describe, expect, it } from "vitest";
import {
  APP_MANIFEST_DESCRIPTION,
  APP_MANIFEST_PERMISSIONS,
  APP_PERMISSION_RATIONALE,
  appInstallUrl,
  buildAppManifest,
  defaultAppName,
  exchangeManifestCode,
  extractManifestCode,
  manifestSubmitUrl,
  renderManifestFormPage,
  renderManifestRationale,
} from "./app-manifest.ts";

describe("buildAppManifest", () => {
  const manifest = buildAppManifest({
    name: "fixowl-octocat",
    homepageUrl: "https://github.com/NachoPal/fixowl",
    redirectUrl: "http://127.0.0.1:8123/callback",
  });

  it("pre-fills exactly the night run's permissions: write where it acts, read where it observes", () => {
    expect(manifest.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
      actions: "read",
      administration: "read",
    });
  });

  it("declares no webhook (fixowl polls; GitHub creates the App with the webhook off)", () => {
    expect(manifest).not.toHaveProperty("hook_attributes");
    expect(manifest).not.toHaveProperty("default_events");
  });

  it("keeps the App private to the owning account and carries name/url/redirect", () => {
    expect(manifest.public).toBe(false);
    expect(manifest.name).toBe("fixowl-octocat");
    expect(manifest.url).toBe("https://github.com/NachoPal/fixowl");
    expect(manifest.redirect_url).toBe("http://127.0.0.1:8123/callback");
  });

  it("carries a concise, accurate description for GitHub's create page", () => {
    expect(manifest.description).toBe(APP_MANIFEST_DESCRIPTION);
    // Short enough to read cleanly on the confirmation page, and states the
    // one invariant that matters (never merges) without overclaiming.
    expect(APP_MANIFEST_DESCRIPTION.length).toBeLessThanOrEqual(120);
    expect(APP_MANIFEST_DESCRIPTION).toMatch(/never merges/);
  });
});

describe("the pre-fill rationale", () => {
  it("explains every manifest permission (least-privilege justification stays in lockstep)", () => {
    const explained = APP_PERMISSION_RATIONALE.map((entry) => entry.key);
    expect(explained.toSorted()).toEqual(Object.keys(APP_MANIFEST_PERMISSIONS).toSorted());
  });

  it("states the exact access level the manifest grants for each permission", () => {
    for (const entry of APP_PERMISSION_RATIONALE) {
      expect(entry.access).toBe(APP_MANIFEST_PERMISSIONS[entry.key]);
    }
  });

  it("renders one line per permission plus the webhook-off and no-access rows", () => {
    const block = renderManifestRationale("  ");
    expect(block).toContain("Contents: write");
    expect(block).toContain("Administration: read");
    expect(block).toContain("Webhook: off");
    expect(block).toContain("Everything else: no access");
    expect(block.split("\n")).toHaveLength(APP_PERMISSION_RATIONALE.length + 2);
  });
});

describe("manifestSubmitUrl", () => {
  it("targets the personal create-App page by default, carrying the anti-CSRF state", () => {
    expect(manifestSubmitUrl({ state: "abc123" })).toBe(
      "https://github.com/settings/apps/new?state=abc123",
    );
  });

  it("targets the organization create-App page when an org is given", () => {
    expect(manifestSubmitUrl({ org: "my-org", state: "s" })).toBe(
      "https://github.com/organizations/my-org/settings/apps/new?state=s",
    );
  });
});

describe("renderManifestFormPage", () => {
  it("embeds the manifest as an escaped form field posting to the submit URL", () => {
    const manifest = buildAppManifest({
      name: 'owl "quoted"',
      homepageUrl: "https://example.com",
      redirectUrl: "http://127.0.0.1:1/callback",
    });
    const page = renderManifestFormPage(manifest, "https://github.com/settings/apps/new?state=x");
    expect(page).toContain('action="https://github.com/settings/apps/new?state=x"');
    expect(page).toContain('name="manifest"');
    // The JSON is HTML-escaped, so the quoted name cannot break out of the attribute.
    expect(page).toContain("owl \\&quot;quoted\\&quot;");
    expect(page).not.toContain('value="{"');
    // Auto-submits, with a visible button as the no-JS fallback.
    expect(page).toContain("submit()");
    expect(page).toContain("<button");
  });
});

describe("defaultAppName", () => {
  it("suggests fixowl-<login>", () => {
    expect(defaultAppName("octocat")).toBe("fixowl-octocat");
  });

  it("stays within GitHub's 34-char App name cap", () => {
    expect(defaultAppName("a".repeat(60))).toHaveLength(34);
  });
});

describe("appInstallUrl", () => {
  it("points at the App's repository-picking install page", () => {
    expect(appInstallUrl("fixowl-octocat")).toBe(
      "https://github.com/apps/fixowl-octocat/installations/new",
    );
  });
});

describe("extractManifestCode", () => {
  it("accepts a bare code", () => {
    expect(extractManifestCode(" a180b1a3d263c81bc6441d7b990bae27d4c10679 ")).toBe(
      "a180b1a3d263c81bc6441d7b990bae27d4c10679",
    );
  });

  it("accepts the full redirected URL pasted from the address bar", () => {
    expect(extractManifestCode("https://github.com/settings/apps?code=abc123&state=s")).toBe(
      "abc123",
    );
  });

  it("rejects answers with no code in them", () => {
    expect(extractManifestCode("")).toBeUndefined();
    expect(extractManifestCode("https://github.com/settings/apps")).toBeUndefined();
    expect(extractManifestCode("not a code!!")).toBeUndefined();
  });
});

describe("exchangeManifestCode", () => {
  const conversion = {
    id: 12345,
    slug: "fixowl-octocat",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMII…\n-----END RSA PRIVATE KEY-----\n",
    html_url: "https://github.com/apps/fixowl-octocat",
  };

  it("POSTs the code to the conversion endpoint and returns id, slug and key", async () => {
    let requested: { url: string; method?: string } | undefined;
    const fetchFn = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requested = { url: String(url), method: init?.method };
      return new Response(JSON.stringify(conversion), { status: 201 });
    }) as typeof fetch;

    const result = await exchangeManifestCode(" the-code ", fetchFn);

    expect(requested).toEqual({
      url: "https://api.github.com/app-manifests/the-code/conversions",
      method: "POST",
    });
    expect(result).toEqual({
      appId: 12345,
      slug: "fixowl-octocat",
      pem: conversion.pem,
      htmlUrl: "https://github.com/apps/fixowl-octocat",
    });
  });

  it("explains that a 404 means the single-use code expired", async () => {
    const fetchFn = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    await expect(exchangeManifestCode("stale", fetchFn)).rejects.toThrow(/expires after 1 hour/);
  });

  it("refuses a response missing the private key", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ id: 1, slug: "x" }), { status: 201 })) as typeof fetch;
    await expect(exchangeManifestCode("c", fetchFn)).rejects.toThrow(
      /missing the App id or private key/,
    );
  });
});
