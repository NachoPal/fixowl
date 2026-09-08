import { createServer, type Server } from "node:http";

/**
 * The localhost end of the App Manifest flow: one tiny loopback-only HTTP
 * server that (a) serves the auto-submitting manifest form page and (b)
 * catches GitHub's redirect carrying the temporary code. Port 0 picks a free
 * ephemeral port; nothing here is reachable off-host.
 */

export interface ManifestCaptureOptions {
  /**
   * Renders the form page for the redirect URL this server ends up owning
   * (the port is unknown until the listener is bound, and the manifest must
   * embed the final redirect URL, hence the callback).
   */
  pageForRedirect: (redirectUrl: string) => string;
  /** Anti-CSRF token embedded in the submit URL; the redirect must echo it. */
  state: string;
  /** Give up waiting after this long. Defaults to 15 minutes. */
  timeoutMs?: number;
}

export interface ManifestCapture {
  /** The page the browser opens first (serves the form). */
  url: string;
  /** Resolves with the temporary code, or rejects on timeout/server error. */
  code: Promise<string>;
  /** Stops the server; always call it, resolved or not. */
  close: () => void;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** The page shown after the code is captured. */
const DONE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>fixowl - App created</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
<h1>&#129417; All set</h1>
<p>fixowl received the App credentials. You can close this tab and return to
the terminal.</p>
</body></html>
`;

/**
 * Starts the capture server and resolves once it is listening. GET `/` serves
 * the manifest form; GET `/callback?code=...&state=...` resolves the code when
 * the state matches. A wrong or missing state is refused and the wait
 * continues - only GitHub's own redirect (which echoes our state) can complete
 * the flow, so another local process cannot feed the wizard a foreign App.
 */
export function startManifestCapture(options: ManifestCaptureOptions): Promise<ManifestCapture> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(options.pageForRedirect(`http://127.0.0.1:${port}/callback`));
      return;
    }
    if (url.pathname === "/callback") {
      const received = url.searchParams.get("code");
      if (url.searchParams.get("state") !== options.state) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("state mismatch; ignoring this redirect\n");
        return;
      }
      if (received === null || received === "") {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("missing code parameter\n");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(DONE_PAGE);
      resolveCode(received);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });

  const timeout = setTimeout(() => {
    rejectCode(
      new Error(
        "timed out waiting for the browser step; re-run to try again (or pick the headless option)",
      ),
    );
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref();

  const close = (): void => {
    clearTimeout(timeout);
    server.close();
    // A close before the redirect arrived abandons the wait; make sure the
    // promise settles so no await hangs forever.
    rejectCode(new Error("manifest capture server closed before the code arrived"));
  };
  // Settling twice is a no-op, so close() after a successful capture is safe.
  void code.catch(() => {});

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, code, close });
    });
  });
}
