/** True only when both Clerk settings are present, the one signal that hosted mode is on
 * (ADR 0090 §5). A half-configured setup is not hosted, so the local-mode guards stay in force and
 * fail closed. */
export function isHostedMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLERK_JWT_KEY) && Boolean(env.PATH_ALLOWED_ORIGIN);
}
