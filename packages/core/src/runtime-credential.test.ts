import { describe, expect, it } from "vitest";
import {
  APP_ID_SECRET,
  APP_INSTALLATION_ID_SECRET,
  APP_PRIVATE_KEY_SECRET,
  LEGACY_RUNTIME_TOKEN_SECRET,
} from "./secret-names.ts";
import { resolveRuntimeCredentialFromEnv } from "./runtime-credential.ts";

const appEnv = {
  [APP_ID_SECRET]: "123456",
  [APP_INSTALLATION_ID_SECRET]: "7890123",
  [APP_PRIVATE_KEY_SECRET]: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
};

describe("resolveRuntimeCredentialFromEnv", () => {
  it("resolves the App when its three secrets are all present", () => {
    expect(resolveRuntimeCredentialFromEnv(appEnv)).toEqual({
      appId: 123456,
      installationId: 7890123,
      privateKey: appEnv[APP_PRIVATE_KEY_SECRET],
    });
  });

  it("throws, naming every App secret, when none is present", () => {
    expect(() => resolveRuntimeCredentialFromEnv({})).toThrow(
      new RegExp(
        `missing ${APP_ID_SECRET}, ${APP_INSTALLATION_ID_SECRET}, ${APP_PRIVATE_KEY_SECRET}`,
      ),
    );
  });

  it("throws, naming the missing secret, when the App trio is partial", () => {
    expect(() =>
      resolveRuntimeCredentialFromEnv({
        [APP_ID_SECRET]: "123456",
        [APP_INSTALLATION_ID_SECRET]: "7890123",
        // private key missing
      }),
    ).toThrow(new RegExp(`missing ${APP_PRIVATE_KEY_SECRET}\\.`));
  });

  it("treats empty-string secrets as absent", () => {
    expect(() =>
      resolveRuntimeCredentialFromEnv({
        [APP_ID_SECRET]: "",
        [APP_INSTALLATION_ID_SECRET]: "",
        [APP_PRIVATE_KEY_SECRET]: "",
      }),
    ).toThrow(/no GitHub App runtime credential/i);
  });

  it("rejects the removed runtime PAT with a migration message (never a silent fallback)", () => {
    expect(() =>
      resolveRuntimeCredentialFromEnv({ [LEGACY_RUNTIME_TOKEN_SECRET]: "ghp_runtime" }),
    ).toThrow(/removed runtime PAT[\s\S]*fixowl provision[\s\S]*docs\/app-auth\.md/);
  });

  it("ignores the legacy secret once the App trio is complete", () => {
    expect(
      resolveRuntimeCredentialFromEnv({ ...appEnv, [LEGACY_RUNTIME_TOKEN_SECRET]: "ghp_runtime" }),
    ).toMatchObject({ appId: 123456 });
  });

  it("rejects a non-numeric App id", () => {
    expect(() =>
      resolveRuntimeCredentialFromEnv({ ...appEnv, [APP_ID_SECRET]: "not-a-number" }),
    ).toThrow(new RegExp(`${APP_ID_SECRET} must be a positive integer`));
  });
});
