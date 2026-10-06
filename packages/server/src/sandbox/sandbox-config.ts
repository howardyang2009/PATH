import { HOST_ENV_ALLOWLIST } from "../secret-store.js";
import { appleContainerRuntime } from "./apple-container.js";
import { SANDBOX_LIMITS, type SandboxOptions } from "./sandboxed-runs.js";
import { createVmSlots } from "./vm-slots.js";

/**
 * The sandbox a hosted Server runs Starts in, read from `env`: on when `PATH_SANDBOX_IMAGE` names
 * the run image, with `PATH_SANDBOX_NETWORK` as the VMs' network. `undefined` when off.
 */
export function readSandboxOptions(
  env: NodeJS.ProcessEnv = process.env,
): SandboxOptions | undefined {
  const image = env.PATH_SANDBOX_IMAGE;
  if (!image) return undefined;
  const hostEnv: { [name: string]: string } = {};
  for (const name of HOST_ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined) hostEnv[name] = value;
  }
  return {
    runtime: appleContainerRuntime(),
    slots: createVmSlots(SANDBOX_LIMITS.maxVms),
    image,
    cpus: SANDBOX_LIMITS.cpus,
    memoryMiB: SANDBOX_LIMITS.memoryMiB,
    timeoutMs: SANDBOX_LIMITS.timeoutMs,
    stopGraceMs: SANDBOX_LIMITS.stopGraceMs,
    maxExportBytes: SANDBOX_LIMITS.maxExportBytes,
    maxBlobBytes: SANDBOX_LIMITS.maxBlobBytes,
    network: env.PATH_SANDBOX_NETWORK || undefined,
    hostEnv,
  };
}
