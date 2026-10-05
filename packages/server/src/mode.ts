/** True only when both Clerk settings are present, the one signal that hosted mode is on
 * (ADR 0090 §5). A half-configured setup is not hosted, so the local-mode guards stay in force and
 * fail closed. */
export function isHostedMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLERK_JWT_KEY) && Boolean(env.PATH_ALLOWED_ORIGIN);
}

/** The mode one server process runs in, with the Clerk settings hosted mode verifies against. */
export type ServerMode =
  | { mode: "local" }
  | { mode: "hosted"; jwtKey: string; allowedOrigin: string; publishableKey: string };

/**
 * Reads the server mode from `env`. Throws on a half-configured hosted setup, so the Server refuses
 * to start instead of falling back to `local` (ADR 0090 §5).
 */
export function readServerMode(env: NodeJS.ProcessEnv = process.env): ServerMode {
  const jwtKey = env.CLERK_JWT_KEY;
  const allowedOrigin = env.PATH_ALLOWED_ORIGIN;
  if (!jwtKey && !allowedOrigin) return { mode: "local" };
  if (!jwtKey || !allowedOrigin) {
    const missing = jwtKey ? "PATH_ALLOWED_ORIGIN" : "CLERK_JWT_KEY";
    throw new Error(`hosted mode is half-configured: ${missing} is not set. Refusing to start`);
  }
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error("hosted mode needs CLERK_PUBLISHABLE_KEY for sign-in. Refusing to start");
  }
  return { mode: "hosted", jwtKey, allowedOrigin, publishableKey };
}
