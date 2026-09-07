import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolvePrivateKey, toPkcs8Pem } from "./app-key.ts";

const pkcs1 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
}).privateKey;

const pkcs8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

describe("toPkcs8Pem", () => {
  it("normalizes a PKCS#1 (GitHub-download) key to PKCS#8", () => {
    expect(pkcs1).toContain("-----BEGIN RSA PRIVATE KEY-----");
    const normalized = toPkcs8Pem(pkcs1);
    expect(normalized.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    // The result re-parses as a real private key.
    expect(() => createPrivateKey(normalized)).not.toThrow();
  });

  it("is idempotent on a key that is already PKCS#8", () => {
    const once = toPkcs8Pem(pkcs8);
    expect(once.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(toPkcs8Pem(once)).toBe(once);
  });
});

describe("resolvePrivateKey", () => {
  it("passes a raw PEM through unchanged (trimmed)", () => {
    expect(resolvePrivateKey(`\n${pkcs8}\n`)).toBe(pkcs8.trim());
  });

  it("decodes a base64-encoded PEM (the recommended secrets.env storage form)", () => {
    const base64 = Buffer.from(pkcs8).toString("base64");
    expect(resolvePrivateKey(base64)).toBe(pkcs8);
  });

  it("round-trips base64 storage through normalization to a usable key", () => {
    const base64 = Buffer.from(pkcs1).toString("base64");
    const normalized = toPkcs8Pem(resolvePrivateKey(base64));
    expect(() => createPrivateKey(normalized)).not.toThrow();
  });

  it("throws when the value is neither a PEM nor base64-encoded PEM", () => {
    expect(() => resolvePrivateKey("not-a-key")).toThrow(/neither a PEM nor base64/);
  });
});
