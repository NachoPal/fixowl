import { createPrivateKey } from "node:crypto";

/**
 * GitHub App private-key handling. The decisive gotcha: @octokit/auth-app ->
 * universal-github-app-jwt -> WebCrypto only accepts PKCS#8
 * (`-----BEGIN PRIVATE KEY-----`), but GitHub's downloaded `.pem` is PKCS#1
 * (`-----BEGIN RSA PRIVATE KEY-----`) and the library does NOT auto-convert. So
 * the CLI normalizes to PKCS#8 at provision time and seals that, meaning the
 * action always receives a WebCrypto-compatible key and the operator can paste
 * whatever GitHub gave them.
 */

/**
 * Normalize an RSA private-key PEM to PKCS#8. Node's `createPrivateKey` parses
 * both PKCS#1 and PKCS#8 PEM; we re-export as PKCS#8. Idempotent on a key that
 * is already PKCS#8. (OpenSSH-format keys are not accepted here; convert them
 * first with `ssh-keygen -p -m PKCS8`.)
 */
export function toPkcs8Pem(pem: string): string {
  return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
}

/**
 * Decode the private key as stored in secrets.env. The recommended storage form
 * is base64-encoded PEM, so the multi-line PEM survives the line-based
 * KEY=VALUE parser (`parseSecretsEnv`); a raw PEM pasted directly is also
 * accepted. Returns the decoded PEM (still PKCS#1 or PKCS#8 - call `toPkcs8Pem`
 * to normalize).
 */
export function resolvePrivateKey(stored: string): string {
  const trimmed = stored.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) {
    throw new Error(
      "GitHub App private_key is neither a PEM nor base64-encoded PEM; store the base64 of the " +
        "downloaded .pem in secrets.env (e.g. `base64 -i app.private-key.pem | tr -d '\\n'`)",
    );
  }
  return decoded;
}
