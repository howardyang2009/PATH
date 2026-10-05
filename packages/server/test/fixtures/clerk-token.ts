import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { vi } from "vitest";

/**
 * A Clerk stand-in for hosted-mode tests: a key pair generated per run, and RS256 session tokens in
 * the shape Clerk issues. Verification uses only the public key, so no test makes a network call.
 */

export const ORIGIN = "https://path.example.ts.net";
export const PUBLISHABLE_KEY = "pk_test_cGF0aC5leGFtcGxlJA";
export const USER_ID = "user_2abcDEF123";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const JWT_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A valid session token for `USER_ID`; `claims` override the defaults, and an `undefined` claim
 * is left out. */
export function clerkToken(
  claims: Record<string, unknown> = {},
  key: KeyObject = privateKey,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT", kid: "ins_test" });
  const payload = base64url({
    sub: USER_ID,
    azp: ORIGIN,
    iss: "https://clerk.path.example",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 60,
    ...claims,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

/** Request options that carry `token` as the bearer token. */
export function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

/** Sets the hosted-mode settings for the next `startPathServer`; undo with `vi.unstubAllEnvs`. */
export function stubHostedEnv(): void {
  vi.stubEnv("CLERK_JWT_KEY", JWT_KEY);
  vi.stubEnv("PATH_ALLOWED_ORIGIN", ORIGIN);
  vi.stubEnv("CLERK_PUBLISHABLE_KEY", PUBLISHABLE_KEY);
}
