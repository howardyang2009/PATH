import {
  type ConfigObject,
  isEnvWrapper,
  isSecretWrapper,
  type JsonValue,
  type LaunchFacts,
  mapSecrets,
  updateAtConfigPath,
  valueAtConfigPath,
} from "@path/schema";
import { mergeConfig } from "./merge-config.js";
import { type EnvSource, resolveEffectiveConfig } from "./resolve-env.js";

// The operator's **launch facts** (ADR 0046), assembled, masked, and recovered in one place: what an
// operator supplied at launch, what a continuation must restore, and which config values were secrets
// and are therefore *not* in the frozen copy. The frozen `config` is the **effective** operator config
// (`$env` resolved, `$secret` unwrapped), because that is the value the run actually used.

/** The operator-supplied half of a launch, before anything is resolved or masked. */
export interface LaunchFactInputs {
  input?: JsonValue;
  /** The override config as the operator supplied it, `$secret` wrappers intact. */
  config?: ConfigObject;
  /** The launch worker-default table (ADR 0044). */
  workerDefaults?: { [stepType: string]: string };
}

/** Every dot-path in a config object whose value is a `$secret` wrapper, keyed by the object's own key. */
export function secretPathsOf(config: ConfigObject): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    mapSecrets(
      value as unknown as JsonValue,
      (secret, path) => {
        paths.push(path);
        return secret;
      },
      key,
    );
  }
  return paths;
}

// What to freeze for one launch, or `undefined` when the launch supplied nothing beyond the file.
// `inheritedSecretKeys` carries secrets a continuation already knows, whose wrappers its config lost.
export function buildLaunchFacts(
  inputs: LaunchFactInputs,
  env: EnvSource,
  inheritedSecretKeys: readonly string[] = [],
): LaunchFacts | undefined {
  const { input, config, workerDefaults } = inputs;
  if (
    input === undefined &&
    config === undefined &&
    workerDefaults === undefined &&
    inheritedSecretKeys.length === 0
  ) {
    return undefined;
  }
  const secretKeys =
    config === undefined
      ? [...inheritedSecretKeys]
      : [...new Set([...secretPathsOf(config), ...inheritedSecretKeys])];
  return {
    ...(input !== undefined ? { input } : {}),
    ...(config !== undefined ? { config: resolveEffectiveConfig(config, env) } : {}),
    ...(workerDefaults !== undefined ? { workerDefaults } : {}),
    ...(secretKeys.length > 0 ? { secretKeys } : {}),
  };
}

/** What a continuation gets back from the frozen facts plus whatever the caller supplied this time. */
export interface RecoveredLaunch {
  config: ConfigObject | undefined;
  /** Frozen paths whose secret the caller did not supply again — the values are still mask tokens. */
  missingSecretKeys: string[];
}

// Config merges **shallow, supplied wins**. A frozen secret the caller did not replace is reported:
// the frozen copy holds a `[secret:<key>]` token, and replaying that token would 401 at the provider.
export function recoverLaunchConfig(
  frozen: LaunchFacts | undefined,
  supplied: ConfigObject | undefined,
): RecoveredLaunch {
  const frozenConfig = frozen?.config;
  const config =
    frozenConfig === undefined
      ? supplied
      : supplied === undefined
        ? frozenConfig
        : mergeConfig(frozenConfig, supplied);
  const missingSecretKeys = (frozen?.secretKeys ?? []).filter(
    (path) => valueAtConfigPath(supplied as unknown as JsonValue | undefined, path) === undefined,
  );
  return { config, missingSecretKeys };
}

// Re-marks values a continuation supplied at paths the frozen facts recorded as secrets: `collectSecrets`
// walks only `$secret` wrappers, and without this a re-entered credential would reach disk in the clear.
export function wrapSecretsAtPaths(config: ConfigObject, paths: readonly string[]): ConfigObject {
  let wrapped = config as unknown as JsonValue;
  for (const path of paths) {
    wrapped = updateAtConfigPath(wrapped, path, (leaf) =>
      // Already marked, or a value a `$secret` cannot hold: left alone. An `$env` wrapper is marked too —
      // `{"$secret": {"$env": …}}` is the composed form (ADR 0022).
      isSecretWrapper(leaf) || (typeof leaf !== "string" && !isEnvWrapper(leaf))
        ? leaf
        : ({ $secret: leaf } as unknown as JsonValue),
    );
  }
  return wrapped as unknown as ConfigObject;
}

/** The run-start failure for a continuation whose launch secrets were not supplied again. */
export function describeMissingLaunchSecrets(paths: readonly string[]): string {
  const list = paths.map((path) => `"${path}"`).join(", ");
  return paths.length === 1
    ? `run failed before its first step: launch config secret ${list} was not supplied again`
    : `run failed before its first step: ${paths.length} launch config secrets were not supplied again: ${list}`;
}
