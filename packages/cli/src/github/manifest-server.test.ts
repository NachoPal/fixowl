import { describe, expect, it } from "vitest";
import { startManifestCapture } from "./manifest-server.ts";

describe("startManifestCapture", () => {
  it("serves the form page with the redirect URL it owns, then captures the code", async () => {
    const capture = await startManifestCapture({
      state: "s3cret",
      pageForRedirect: (redirectUrl) => `<html>form -> ${redirectUrl}</html>`,
    });
    try {
      const page = await (await fetch(capture.url)).text();
      const match = /form -> (\S+)</.exec(page);
      expect(match?.[1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const redirect = await fetch(`${match?.[1]}?code=tempcode&state=s3cret`);
      expect(redirect.status).toBe(200);
      await expect(capture.code).resolves.toBe("tempcode");
    } finally {
      capture.close();
    }
  });

  it("refuses a redirect whose state does not match (a local process cannot inject an App)", async () => {
    const capture = await startManifestCapture({
      state: "expected",
      pageForRedirect: () => "page",
      timeoutMs: 5000,
    });
    try {
      const url = new URL("/callback?code=evil&state=wrong", capture.url);
      const forged = await fetch(url);
      expect(forged.status).toBe(403);

      // The wait is still open; the genuine redirect completes it afterwards.
      const genuine = await fetch(new URL("/callback?code=real&state=expected", capture.url));
      expect(genuine.status).toBe(200);
      await expect(capture.code).resolves.toBe("real");
    } finally {
      capture.close();
    }
  });

  it("rejects a callback without a code", async () => {
    const capture = await startManifestCapture({
      state: "s",
      pageForRedirect: () => "page",
      timeoutMs: 5000,
    });
    try {
      const response = await fetch(new URL("/callback?state=s", capture.url));
      expect(response.status).toBe(400);
    } finally {
      capture.close();
    }
  });

  it("rejects the wait when closed before any code arrived", async () => {
    const capture = await startManifestCapture({
      state: "s",
      pageForRedirect: () => "page",
    });
    capture.close();
    await expect(capture.code).rejects.toThrow(/closed before the code arrived/);
  });

  it("times out instead of hanging forever", async () => {
    const capture = await startManifestCapture({
      state: "s",
      pageForRedirect: () => "page",
      timeoutMs: 10,
    });
    try {
      await expect(capture.code).rejects.toThrow(/timed out/);
    } finally {
      capture.close();
    }
  });
});
