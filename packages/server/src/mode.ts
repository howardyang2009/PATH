import type { ClerkIdentityOptions } from "./clerk-identity.js";
import { type RequestLimits, readRequestLimits } from "./request-limits.js";
import { appleContainerRuntime } from "./sandbox/apple-container.js";
import { egressAnchorFailure } from "./sandbox/egress-anchor.js";
import { readSandboxOptions } from "./sandbox/sandbox-config.js";
import type { SandboxRuntime } from "./sandbox/sandbox-runtime.js";
import type { SandboxOptions } from "./sandbox/sandboxed-runs.js";
import { parseSecretsKey, type SecretsKey } from "./secret-store.js";

/** The mode one server process runs in. Hosted mode carries every Server-side item of the gate
 * (docs/spec/path-website.md §11); `publishableKey` is what a client signs in with, and local mode
 * has none. */
export type ServerMode =
  | { mode: "local"; publishableKey: null }
  | {
      mode: "hosted";
      publishableKey: string;
      clerk: ClerkIdentityOptions;
      secretsKey: SecretsKey;
      previousSecretsKey?: SecretsKey;
      sandbox: SandboxOptions;
      limits: RequestLimits;
    };

/**
 * Reads the server mode from `env`. Hosted mode is asked for when `CLERK_JWT_KEY` or
 * `PATH_ALLOWED_ORIGIN` is set, and then every gate item must hold: one refusal names each item
 * that does not, so the Server refuses to start instead of falling back to `local`.
 */
export function readServerMode(
  env: NodeJS.ProcessEnv = process.env,
  projectDir: string = process.cwd(),
  runtime: SandboxRuntime = appleContainerRuntime(),
): ServerMode {
  if (!env.CLERK_JWT_KEY && !env.PATH_ALLOWED_ORIGIN)
    return { mode: "local", publishableKey: null };

  const failures: string[] = [];
  const attempt = <T>(read: () => T, prefix = ""): T | undefined => {
    try {
      return read();
    } catch (err) {
      failures.push(prefix + (err instanceof Error ? err.message : String(err)));
      return undefined;
    }
  };
  const required = (name: string): string | undefined => {
    const value = env[name];
    if (!value) failures.push(`${name} is not set`);
    return value;
  };

  const jwtKey = required("CLERK_JWT_KEY");
  const allowedOrigin = required("PATH_ALLOWED_ORIGIN");
  const publishableKey = required("CLERK_PUBLISHABLE_KEY");
  const rawSecretsKey = required("PATH_SECRETS_KEY");
  const secretsKey = rawSecretsKey ? attempt(() => parseSecretsKey(rawSecretsKey)) : undefined;
  const rawPrevious = env.PATH_SECRETS_KEY_PREVIOUS;
  const previousSecretsKey = rawPrevious
    ? attempt(() => parseSecretsKey(rawPrevious, "PATH_SECRETS_KEY_PREVIOUS"))
    : undefined;
  const sandbox = readSandboxOptions(env, runtime);
  if (sandbox === undefined) {
    failures.push(
      "SandboxedRuns is off: PATH_SANDBOX_IMAGE is not set, and in-process runs are refused in hosted mode",
    );
  }
  const limits = attempt(() => readRequestLimits(projectDir), "abuse limits: ");
  const anchor = egressAnchorFailure(env);
  if (anchor !== undefined) failures.push(anchor);

  if (
    failures.length > 0 ||
    !jwtKey ||
    !allowedOrigin ||
    !publishableKey ||
    !secretsKey ||
    !sandbox ||
    !limits
  ) {
    throw new Error(`hosted mode refuses to start:\n- ${failures.join("\n- ")}`);
  }
  return {
    mode: "hosted",
    publishableKey,
    clerk: { jwtKey, allowedOrigin },
    secretsKey,
    ...(previousSecretsKey ? { previousSecretsKey } : {}),
    sandbox,
    limits,
  };
}
