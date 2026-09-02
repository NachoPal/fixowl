import sodium from "libsodium-wrappers";

/**
 * GitHub Actions secrets are encrypted client-side with a libsodium sealed box
 * against the repo's public key; GitHub never sees the plaintext in the API
 * call payload beyond TLS.
 */
export async function sealSecret(repoPublicKeyB64: string, value: string): Promise<string> {
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(repoPublicKeyB64, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
