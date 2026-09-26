import { isEnvWrapper, isSecretWrapper, mapSecrets, updateAtConfigPath, valueAtConfigPath, type ConfigObject, type JsonValue, type LaunchFacts } from "@path/schema";
import { mergeConfig } from "./merge-config.js";
import { resolveEffectiveConfig, type EnvSource } from "./resolve-env.js";

/**
 * The operator's **launch facts** (ADR 0046), assembled, masked, and recovered in one place.
 *
 * Three modules need the same three answers — what an operator supplied at launch (`runWorkflow`
 * freezes it on the root run-started), what a continuation must restore (`Project.resume`/`complete`
 * recover config and worker-defaults from the frozen copy), and which config values were secrets and
 * are therefore *not* in that copy. Keeping the walk here means one predicate for "which paths are
 * secrets" and one rule for "is this secret still missing", rather than a copy in each caller.
 *
 * The frozen `config` is the **effective** operator config — `$env` resolved and `$secret` unwrapped —
 * because that is the value the run actually used; the observation seam then scrubs the secret values
 * by value, so what reaches disk is `[secret:<key>]` and `secretKeys` names the paths it stood for.
 */

/** The operator-supplied half of a launch, before anything is resolved or masked. */
export interface LaunchFactInputs {
  /** The override input seed as the operator supplied it, absent when they supplied none. */
  input?: JsonValue;
  /** The override config as the operator supplied it, `$secret` wrappers intact. */
  config?: ConfigObject;
  /** The launch worker-default table (ADR 0044). */
  workerDefaults?: { [stepType: string]: string };
}

/**
 * Every dot-path in a config object whose value is a `$secret` wrapper, walked per config *value*
 * keyed by the object's own key — the same shape rule `resolve-env.ts` and `secret-mask.ts` follow,
 * so a config field awkwardly named `$secret` is a field, not a wrapper.
 */
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

/**
 * What to freeze for one launch, or `undefined` when the launch supplied nothing beyond the file — a
 * run with no `launch_facts` is a run whose tree shows nothing extra, not a row of empty fields.
 * `inheritedSecretKeys` carries the paths a continuation already knows were secrets: its recovered
 * config is unwrapped, so the wrappers that would have marked them are gone by then.
 */
export function buildLaunchFacts(
  inputs: LaunchFactInputs,
  env: EnvSource,
  inheritedSecretKeys: readonly string[] = [],
): LaunchFacts | undefined {
  const { input, config, workerDefaults } = inputs;
  if (input === undefined && config === undefined && workerDefaults === undefined && inheritedSecretKeys.length === 0) {
    return undefined;
  }
  const secretKeys = config === undefined ? [...inheritedSecretKeys] : [...new Set([...secretPathsOf(config), ...inheritedSecretKeys])];
  return {
    ...(input !== undefined ? { input } : {}),
    ...(config !== undefined ? { config: resolveEffectiveConfig(config, env) } : {}),
    ...(workerDefaults !== undefined ? { workerDefaults } : {}),
    ...(secretKeys.length > 0 ? { secretKeys } : {}),
  };
}

/** What a continuation gets back from the frozen facts plus whatever the caller supplied this time. */
export interface RecoveredLaunch {
  /** The config to run with: the frozen one, the supplied one, or the supplied merged over frozen. */
  config: ConfigObject | undefined;
  /** Frozen paths whose secret the caller did not supply again — the values are still mask tokens. */
  missingSecretKeys: string[];
}

/**
 * The recovery rule for a continuation. Config merges **shallow, supplied wins**, exactly as an
 * operator override merges over a file's defaults: the frozen copy is the run's own config, and a
 * value supplied on the continuation is a deliberate replacement for it. A frozen secret the caller
 * did not replace is reported, because the frozen copy holds a `[secret:<key>]` token where the
 * credential was — replaying the token would send a non-credential to a provider that answers 401.
 */
export function recoverLaunchConfig(
  frozen: LaunchFacts | undefined,
  supplied: ConfigObject | undefined,
): RecoveredLaunch {
  const frozenConfig = frozen?.config;
  const config =
    frozenConfig === undefined ? supplied : supplied === undefined ? frozenConfig : mergeConfig(frozenConfig, supplied);
  const missingSecretKeys = (frozen?.secretKeys ?? []).filter(
    (path) => valueAtConfigPath(supplied as unknown as JsonValue | undefined, path) === undefined,
  );
  return { config, missingSecretKeys };
}

/**
 * Re-marks the values a continuation supplied for paths the frozen facts recorded as secrets.
 *
 * The operator's re-entry arrives as a plain config value — the Viewer types it, the CLI passes it —
 * and a plain value is exactly what the masker does not know about: `collectSecrets` walks `$secret`
 * wrappers, so without this the successor would record the re-entered credential in the clear, on disk.
 * Wrapping each supplied value at a recorded secret path restores the marking, so the credential is
 * masked at the same choke point as on the launch, while the worker still receives the real value
 * (`resolveEffectiveConfig` unwraps it). A path through an array reads its numeric segment as the
 * index, exactly as `mapSecrets` wrote it, so a secret inside a list is re-marked too.
 */
export function wrapSecretsAtPaths(config: ConfigObject, paths: readonly string[]): ConfigObject {
  let wrapped = config as unknown as JsonValue;
  for (const path of paths) {
    wrapped = updateAtConfigPath(wrapped, path, (leaf) =>
      // Already marked, or a value a `$secret` cannot hold: left alone. An `$env` wrapper is marked too —
      // `{"$secret": {"$env": …}}` is the composed form (ADR 0022).
      isSecretWrapper(leaf) || (typeof leaf !== "string" && !isEnvWrapper(leaf)) ? leaf : ({ $secret: leaf } as unknown as JsonValue),
    );
  }
  return wrapped as unknown as ConfigObject;
}

/**
 * The run-start failure for a continuation whose launch secrets were not supplied again. Worded like
 * `describeUnsetEnv` — the run starts and is on the record, and it ends before its first step — and it
 * names every key for the same reason: one message an operator can act on, not the first of several.
 */
export function describeMissingLaunchSecrets(paths: readonly string[]): string {
  const list = paths.map((path) => `"${path}"`).join(", ");
  return paths.length === 1
    ? `run failed before its first step: launch config secret ${list} was not supplied again`
    : `run failed before its first step: ${paths.length} launch config secrets were not supplied again: ${list}`;
}
