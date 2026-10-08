import { describe, expect, it } from "vitest";
import { readServerMode } from "../src/mode.js";
import { parseSecretsKey } from "../src/secret-store.js";
import { JWT_KEY, ORIGIN, PUBLISHABLE_KEY, SECRETS_KEY } from "./fixtures/clerk-token.js";

const HOSTED = {
  CLERK_JWT_KEY: JWT_KEY,
  PATH_ALLOWED_ORIGIN: ORIGIN,
  CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
  PATH_SECRETS_KEY: SECRETS_KEY,
};

describe("readServerMode", () => {
  it("is local with no Clerk settings", () => {
    expect(readServerMode({})).toEqual({ mode: "local", publishableKey: null });
  });

  it("is hosted with both settings, the publishable key and the secrets key", () => {
    expect(readServerMode(HOSTED)).toEqual({
      mode: "hosted",
      publishableKey: PUBLISHABLE_KEY,
      clerk: { jwtKey: JWT_KEY, allowedOrigin: ORIGIN },
      secretsKey: parseSecretsKey(SECRETS_KEY),
    });
  });

  it("refuses hosted mode without the secrets key", () => {
    expect(() => readServerMode({ ...HOSTED, PATH_SECRETS_KEY: undefined })).toThrow(
      /PATH_SECRETS_KEY/,
    );
  });

  it("reads the previous secrets key during a rotation", () => {
    const previous = Buffer.alloc(32, 7).toString("base64");
    const mode = readServerMode({ ...HOSTED, PATH_SECRETS_KEY_PREVIOUS: previous });
    expect(mode).toMatchObject({
      secretsKey: parseSecretsKey(SECRETS_KEY),
      previousSecretsKey: parseSecretsKey(previous),
    });
  });

  it("refuses a malformed previous secrets key", () => {
    expect(() => readServerMode({ ...HOSTED, PATH_SECRETS_KEY_PREVIOUS: "short" })).toThrow(
      /PATH_SECRETS_KEY_PREVIOUS/,
    );
  });

  it("refuses hosted mode with a malformed secrets key", () => {
    expect(() => readServerMode({ ...HOSTED, PATH_SECRETS_KEY: "short" })).toThrow(
      /PATH_SECRETS_KEY/,
    );
  });

  it("refuses CLERK_JWT_KEY alone", () => {
    expect(() => readServerMode({ CLERK_JWT_KEY: JWT_KEY })).toThrow(/PATH_ALLOWED_ORIGIN/);
  });

  it("refuses PATH_ALLOWED_ORIGIN alone", () => {
    expect(() => readServerMode({ PATH_ALLOWED_ORIGIN: ORIGIN })).toThrow(/CLERK_JWT_KEY/);
  });

  it("refuses hosted mode without a publishable key", () => {
    expect(() => readServerMode({ CLERK_JWT_KEY: JWT_KEY, PATH_ALLOWED_ORIGIN: ORIGIN })).toThrow(
      /CLERK_PUBLISHABLE_KEY/,
    );
  });
});
