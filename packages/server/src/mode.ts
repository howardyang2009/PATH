import type { ClerkIdentityOptions } from "./clerk-identity.js";
import { parseSecretsKey, type SecretsKey } from "./secret-store.js";

/** The mode one server process runs in. Hosted mode carries the Clerk settings it verifies tokens
 * against and the master key of every Secret store; `publishableKey` is what a client signs in
 * with, and local mode has none. */
export type ServerMode =
  | { mode: "local"; publishableKey: null }
  | {
      mode: "hosted";
      publishableKey: string;
      clerk: ClerkIdentityOptions;
      secretsKey: SecretsKey;
    };

/**
 * Reads the server mode from `env`. Hosted mode is on when `CLERK_JWT_KEY` and
 * `PATH_ALLOWED_ORIGIN` are set; a half-configured setup, or one without `PATH_SECRETS_KEY`, throws,
 * so the Server refuses to start instead of falling back to `local`.
 */
export function readServerMode(env: NodeJS.ProcessEnv = process.env): ServerMode {
  const jwtKey = env.CLERK_JWT_KEY;
  const allowedOrigin = env.PATH_ALLOWED_ORIGIN;
  if (!jwtKey && !allowedOrigin) return { mode: "local", publishableKey: null };
  if (!jwtKey || !allowedOrigin) {
    const missing = jwtKey ? "PATH_ALLOWED_ORIGIN" : "CLERK_JWT_KEY";
    throw new Error(`hosted mode is half-configured: ${missing} is not set. Refusing to start`);
  }
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error("hosted mode needs CLERK_PUBLISHABLE_KEY for sign-in. Refusing to start");
  }
  const secretsKey = env.PATH_SECRETS_KEY;
  if (!secretsKey) {
    throw new Error("hosted mode needs PATH_SECRETS_KEY for the Secret store. Refusing to start");
  }
  return {
    mode: "hosted",
    publishableKey,
    clerk: { jwtKey, allowedOrigin },
    secretsKey: parseSecretsKey(secretsKey),
  };
}
