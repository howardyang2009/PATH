import {
  type ConfigObject,
  type ConfigValue,
  type JsonValue,
  mapEnv,
  mapSecrets,
} from "@path/schema";
import { mergeConfig } from "./merge-config.js";

/**
 * The engine's read of the two config wrappers, `{"$env": "<NAME>"}` (format §7.3) and `{"$secret": …}` (ADR 0022
 * sub-4); where a wrapper may sit is `@path/schema`'s answer. Run start hands the masker the *resolved* values —
 * masking is by value, so collecting before resolution would mask the name, not the credential.
 */

/** A snapshot of the environment: `process.env`'s shape, and anything a test hands over instead. */
export type EnvSource = { readonly [name: string]: string | undefined };

/** One `{"$env": "<NAME>"}` whose variable is not set, with the config key path it was named under. */
export interface UnsetEnvVar {
  name: string;
  /** The dot-path the wrapper sits at, from the config object's own key down — for the operator. */
  key: string;
}

/** The result of resolving one config object: the resolved config and its unset variables. */
export interface EnvResolution {
  config: ConfigObject;
  /** Every unset variable found, one entry per occurrence, in the order the walk reached them. */
  unset: UnsetEnvVar[];
}

/** The run-start reading: every input config resolved, plus the deduped unset list. */
export interface RunEnvResolution {
  configs: ConfigObject[];
  unset: UnsetEnvVar[];
}

/**
 * Resolves every `$env` wrapper in one config object against `env`. An unset wrapper is left standing, not
 * placeholdered (`findUnsetEnv` makes running with one unreachable); empty counts as set — `FOO=` exports an empty
 * value and only an absent name is unset.
 */
export function resolveConfigEnv(config: ConfigObject, env: EnvSource): EnvResolution {
  const unset: UnsetEnvVar[] = [];
  const resolved: ConfigObject = {};

  // Per config *value*, keyed by the object's own key: a config object's keys are field names, not wrapper positions
  // (format §7.3), so walking the object itself would misread a field named `$env`.
  for (const [key, value] of Object.entries(config)) {
    const mapped = mapEnv(
      value as unknown as JsonValue,
      (name, path) => {
        const found = env[name];
        if (found === undefined) {
          unset.push({ name, key: path });
          return { $env: name };
        }
        return found;
      },
      key,
    );
    resolved[key] = mapped as unknown as ConfigValue;
  }

  return { config: resolved, unset };
}

/**
 * The effective config for one merge: `$env` looked up and `$secret` handed back as its real value, in one call —
 * what validation, interpolation, condition evaluation and the worker all read. `$env` stays a separate step because
 * its unset names are reported at run start, and the `$secret` marker is left standing for the masker.
 */
export function resolveEffectiveConfig(merged: ConfigObject, env: EnvSource): ConfigObject {
  return unwrapSecrets(resolveConfigEnv(merged, env).config);
}

/**
 * The effective config at one level (format §7): `override` shadows `base` key by key, then `$env` is resolved and
 * `$secret` unwrapped.
 */
export function effectiveConfig(
  base: ConfigObject,
  override: ConfigObject | undefined,
  env: EnvSource,
): ConfigObject {
  return resolveEffectiveConfig(mergeConfig(base, override), env);
}

/** Every `$secret` in a config object replaced by the value it marks. */
function unwrapSecrets(config: ConfigObject): ConfigObject {
  const resolved: ConfigObject = {};
  for (const [key, value] of Object.entries(config)) {
    resolved[key] = mapSecrets(
      value as unknown as JsonValue,
      (secret) => secret,
    ) as unknown as ConfigValue;
  }
  return resolved;
}

/**
 * The run-start reading over every config a run can read: the resolved configs the masker collects from and every
 * variable not found. One walk answers both, so the halves cannot disagree; the list is deduped by name under the
 * first key naming it.
 */
export function resolveRunEnv(configs: ConfigObject[], env: EnvSource): RunEnvResolution {
  const byName = new Map<string, UnsetEnvVar>();
  const resolved: ConfigObject[] = [];

  for (const config of configs) {
    const resolution = resolveConfigEnv(config, env);
    resolved.push(resolution.config);
    for (const variable of resolution.unset) {
      if (!byName.has(variable.name)) byName.set(variable.name, variable);
    }
  }

  return { configs: resolved, unset: [...byName.values()] };
}

/**
 * The failure a run with unset variables ends on — every name and where each was found, worded "failed before its
 * first step" because the run row already exists.
 */
export function describeUnsetEnv(unset: UnsetEnvVar[]): string {
  const list = unset
    .map((variable) => `"${variable.name}" (config key "${variable.key}")`)
    .join(", ");
  return unset.length === 1
    ? `run failed before its first step: environment variable ${list} is not set`
    : `run failed before its first step: ${unset.length} environment variables are not set: ${list}`;
}
