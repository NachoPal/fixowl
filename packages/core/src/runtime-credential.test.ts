import { describe, expect, it } from "vitest";
import {
  APP_ID_SECRET,
  APP_INSTALLATION_ID_SECRET,
  APP_PRIVATE_KEY_SECRET,
  RUNTIME_TOKEN_SECRET,
} from "./secret-names.ts";
import { resolveRuntimeCredentialFromEnv } from "./runtime-credential.ts";

const appEnv = {
  [APP_ID_SECRET]: "123456",
  [APP_INSTALLATION_ID_SECRET]: "7890123",
  [APP_PRIVATE_KEY_SECRET]: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
};

describe("resolveRuntimeCredentialFromEnv", () => {
  it("selects the App when its three secrets are all present", () => {
    const cred = resolveRuntimeCredentialFromEnv(appEnv);
    expect(cred).toEqual({
      kind: "app",
      appId: 123456,
      installationId: 7890123,
      privateKey: appEnv[APP_PRIVATE_KEY_SECRET],
    });
  });

  it("selects the PAT when only the runtime token is present", () => {
    const cred = resolveRuntimeCredentialFromEnv({ [RUNTIME_TOKEN_SECRET]: "ghp_runtime" });
    expect(cred).toEqual({ kind: "pat", token: "ghp_runtime" });
  });

  it("throws when both an App credential and a PAT are set", () => {
    expect(() =>
      resolveRuntimeCredentialFromEnv({ ...appEnv, [RUNTIME_TOKEN_SECRET]: "ghp_runtime" }),
    ).toThrow(/provision exactly one/i);
  });

  it("throws when no runtime credential is present", () => {
    expect(() => resolveRuntimeCredentialFromEnv({})).toThrow(/no runtime credential/i);
  });

  it("falls back to the PAT when the App trio is only partial", () => {
    const partial = {
      [APP_ID_SECRET]: "123456",
      [APP_PRIVATE_KEY_SECRET]: "-----BEGIN PRIVATE KEY-----\n...\n",
      // installation id missing
      [RUNTIME_TOKEN_SECRET]: "ghp_runtime",
    };
    expect(resolveRuntimeCredentialFromEnv(partial)).toEqual({ kind: "pat", token: "ghp_runtime" });
  });

  it("throws when the App trio is partial and there is no PAT", () => {
    expect(() =>
      resolveRuntimeCredentialFromEnv({
        [APP_ID_SECRET]: "123456",
        [APP_INSTALLATION_ID_SECRET]: "7890123",
        // private key missing
      }),
    ).toThrow(/no runtime credential/i);
  });

  it("treats empty-string secrets as absent", () => {
    expect(() =>
      resolveRuntimeCredentialFromEnv({
        [RUNTIME_TOKEN_SECRET]: "",
        [APP_ID_SECRET]: "",
        [APP_INSTALLATION_ID_SECRET]: "",
        [APP_PRIVATE_KEY_SECRET]: "",
      }),
    ).toThrow(/no runtime credential/i);
  });

  it("rejects a non-numeric App id", () => {
    expect(() =>
      resolveRuntimeCredentialFromEnv({ ...appEnv, [APP_ID_SECRET]: "not-a-number" }),
    ).toThrow(new RegExp(`${APP_ID_SECRET} must be a positive integer`));
  });
});
