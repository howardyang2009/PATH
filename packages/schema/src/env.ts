import type { EnvWrapper } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import { hasOnlyKey, isPlainObject, mapWrappers } from "./wrapper.js";

/**
 * What a `{"$env": "<NAME>"}` config value *is* (workflow-format-v0.md §8.3, mvp-spec.md §8.3), in
 * one place: the shape, and the fact that one may sit at any depth inside a config value —
 * including inside a `$secret` wrapper, which is how a value is sourced from the environment *and*
 * marked for redaction at once.
 *
 * No environment is read here. `@path/schema` is pure — zod is its only dependency and nothing in
 * `src/` imports `node:` — and the purity is the seam: the shape and the walk live here, the read
 * is the engine's. That split is `secret.ts`'s (ticket #98) for the same reason.
 *
 * This is the lower half of that pair: `$env` is the source, `$secret` the marking laid over it, so
 * `secret.ts` imports this module and not the other way round. `mapEnv` needs only the sole-key
 * rule to spot the marking it walks through, never the full `isSecretWrapper` predicate, which is
 * what keeps the pair acyclic; the rule itself and the descent both walks share are `wrapper.ts`'s.
 */

/**
 * True when `$env` is the object's only key — the sole-key rule on its own, regardless of what the
 * key holds. `@path/schema`-internal: it exists so `ConfigValueSchema` can reject a sole-key `$env`
 * object whose value is not a string rather than letting it pass as an ordinary object with an
 * oddly-named key.
 */
export function hasOnlyEnvKey(value: object): value is Record<"$env", JsonValue> {
  return hasOnlyKey(value, "$env");
}

/**
 * True when the value is a well-formed wrapper. A multi-key object that merely carries an `$env`
 * key is a plain object, not a wrapper — the rule `isSecretWrapper` already states.
 */
export function isEnvWrapper(value: unknown): value is EnvWrapper {
  return isPlainObject(value) && hasOnlyEnvKey(value) && typeof value.$env === "string";
}

/**
 * Deep-walks a value and replaces every `$env` wrapper in it with whatever `visit` returns for that
 * variable name, leaving every other leaf untouched. `path` is the dot-path the wrapper was found
 * under, extended from `basePath` with object keys and array indices as segments.
 *
 * Same contract as `mapSecrets`, over the same descent (`wrapper.ts`): a wrapper may sit at any
 * nesting depth rather than only at the leaf a dot-path lands on, and the wrapper's own string is
 * the variable name, not more structure, so it is not walked into.
 *
 * A `$secret` wrapper is walked *through* without becoming a path segment: the marking annotates
 * the value at that path rather than adding a level of structure, so `{a: {$secret: {$env: "N"}}}`
 * reports `a` — the same path `mapSecrets` reports for `{a: {$secret: "s"}}`. Two addresses for one
 * config slot would show up directly in operator-facing text: the masker keys its `[secret:<key>]`
 * token by this path, and a missing-variable failure names it. The marking is left standing over
 * the resolved value, which is what makes the composed form both usable and masked.
 */
export function mapEnv(
  value: JsonValue,
  visit: (name: string, path: string) => JsonValue,
  basePath = "",
): JsonValue {
  return mapWrappers(
    value,
    (node, path) => {
      if (isEnvWrapper(node)) return visit(node.$env, path);
      if (isPlainObject(node) && hasOnlyKey(node, "$secret")) return { $secret: mapEnv(node.$secret, visit, path) };
      return undefined;
    },
    basePath,
  );
}
