import { mapEnv, type ConfigObject, type ConfigValue, type JsonValue } from "@path/schema";

/**
 * The engine's read of the environment behind `{"$env": "<NAME>"}` (workflow-format-v0.md §8.3,
 * ticket #116).
 *
 * Where a wrapper may sit is @path/schema's answer (`mapEnv`); this module only says what to do on
 * reaching one — look the name up, or record it as unset. The same split `interpolate.ts` and
 * `secret-mask.ts` are to `mapSecrets`, and the reason `@path/schema` stays pure: the shape and the
 * walk are the format's, the read is the engine's.
 *
 * Two callers, one policy (`run-workflow.ts`):
 *
 * - **Run start** (`resolveRunEnv`), over every config object the run can read: unset names fail the
 *   run before its first step, and the *resolved* values are what the masker collects. That ordering
 *   is forced — masking is by value (mvp spec §8.3), so a `{"$secret": {"$env": "TOKEN"}}` collected
 *   before resolution would have the masker scrubbing the literal string `TOKEN` while the
 *   credential itself reached disk unmasked.
 * - **Effective config assembly**, at the two points a run materializes one (a file's and a step's),
 *   which is what a worker actually receives. Resolution is idempotent — a resolved value is a
 *   string and no longer a wrapper — so passing an already-resolved merge through again is a no-op.
 */

/** A snapshot of the environment: `process.env`'s shape, and anything a test hands over instead. */
export type EnvSource = { readonly [name: string]: string | undefined };

/** One `{"$env": "<NAME>"}` whose variable is not set, and the config key path it was named under. */
export interface UnsetEnvVar {
  name: string;
  /** The dot-path the wrapper sits at, from the config object's own key down — for the operator. */
  key: string;
}

export interface EnvResolution {
  config: ConfigObject;
  /** Every unset variable found, one entry per occurrence, in the order the walk reached them. */
  unset: UnsetEnvVar[];
}

export interface RunEnvResolution {
  /** The input configs, resolved, in the order given — what the masker collects from. */
  configs: ConfigObject[];
  /** Every unset variable across all of them, deduped by name. */
  unset: UnsetEnvVar[];
}

/**
 * Resolves every `$env` wrapper in one config object against `env`.
 *
 * A wrapper naming an unset variable is **left standing** rather than substituted with a placeholder:
 * there is no value to stand in for, and `mapSecrets` already states what an unresolved wrapper means
 * downstream. A run only ever executes with one of these when its unset names were never checked —
 * `findUnsetEnv` is what makes that unreachable.
 *
 * Empty counts as set. `FOO=` exports an empty value and only an absent name is unset: the engine
 * cannot know whether an empty value is meaningful, and conflating the two would make `FOO=`
 * unexpressible. An empty *secret* is not silent either — it trips the short-secret warning
 * (`secret-mask.ts`), which fires on env-sourced values precisely because resolution runs first.
 */
export function resolveConfigEnv(config: ConfigObject, env: EnvSource): EnvResolution {
  const unset: UnsetEnvVar[] = [];
  const resolved: ConfigObject = {};

  // Per config *value*, keyed by the config object's own key — never over the object itself. A
  // config object's own keys are field names, not wrapper positions (format §8.3), so `"config":
  // {"$env": "TOKEN"}` is a field awkwardly named `$env`; walking the object as a value would
  // silently turn a one-field config into a wrapper. Same reason `secret-mask.ts` collects per key.
  for (const [key, value] of Object.entries(config)) {
    // ConfigValue and JsonValue are structurally compatible (a wrapper is just a plain object
    // shape) but not nominally assignable across their recursive unions.
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
 * The run-start reading, over every config object a run can read: the resolved configs the masker
 * then collects from, and the full list of variables that were not found.
 *
 * One walk answers both. They are the same question asked of the same values, and resolving twice
 * would let the two halves disagree about a variable that changed between them.
 *
 * The list is deduped by name, under the *first* config key naming it — which is a position in the
 * sweep (operator config first) rather than the only place an author declared it. Naming every
 * variable matters; naming every occurrence of one does not.
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
 * The failure a run with unset variables ends on — every name, and where each was found.
 *
 * Worded for what actually happened: the run started and is on the record, and it ended before its
 * first step. "Cannot start" would contradict the run row the operator is reading it off.
 */
export function describeUnsetEnv(unset: UnsetEnvVar[]): string {
  const list = unset.map((variable) => `"${variable.name}" (config key "${variable.key}")`).join(", ");
  return unset.length === 1
    ? `run failed before its first step: environment variable ${list} is not set`
    : `run failed before its first step: ${unset.length} environment variables are not set: ${list}`;
}
