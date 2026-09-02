import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { sealSecret } from "./secrets-sealing.ts";

describe("sealSecret", () => {
  it("produces a sealed box the repo private key can open", async () => {
    await sodium.ready;
    const keypair = sodium.crypto_box_keypair();
    const publicKeyB64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);

    const sealedB64 = await sealSecret(publicKeyB64, "github_pat_super_secret");

    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealedB64, sodium.base64_variants.ORIGINAL),
      keypair.publicKey,
      keypair.privateKey,
    );
    expect(sodium.to_string(opened)).toBe("github_pat_super_secret");
  });

  it("never emits plaintext", async () => {
    await sodium.ready;
    const keypair = sodium.crypto_box_keypair();
    const publicKeyB64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);
    const sealed = await sealSecret(publicKeyB64, "hunter2hunter2");
    expect(sealed).not.toContain("hunter2");
  });
});
