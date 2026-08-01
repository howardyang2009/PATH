import type { EnvWrapper } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import { hasOnlyKey } from "./wrapper-key.js";

/**
 * What a `{"$env": "<NAME>"}` config value *is*, in one place: the shape, and the fact that one may
 * sit at any depth inside a config value — including inside a `$secret` wrapper, which is how a
 * value is sourced from the environment *and* marked for redaction at once.
 *
 * No environment is read here. `@path/schema` is pure — zod is its only dependency and nothing in
 * `src/` imports `node:` — and the purity is the seam: the shape and the walk live here, the read
 * is the engine's. That split is `secret.ts`'s (ticket #98) for the same reason. `mapSecrets` and
 * `mapEnv` meet on the composed form, and two walks that meet must have one owner or they drift on
 * where a wrapper may sit — the exact drift `secret.ts` was written to end.
 *
 * This is the lower half of that pair: `$env` is the source, `$secret` the marking laid over it, so
 * `secret.ts` imports this module and not the other way round. The sole-key rule both need is
 * `wrapper-key.ts`'s, which is why `mapEnv` can recognise the `$secret` marking it walks through
 * without restating what a `$secret` wrapper is.
 */

/**
 * True when `$env` is the object's only key — the sole-key rule on its own, regardless of what the
 * key holds. `@path/schema`-internal: it exists so `ConfigValueSchema` can reject a sole-key `$env`
 * object whose value is not a string rather than letting it pass as an ordinary object with an
 * oddly-named key.
 */
export function hasOnlyEnvKey(value: object): boolean {
  return hasOnlyKey(value, "$env");
}

/**
 * True when the value is a well-formed wrapper. A multi-key object that merely carries an `$env`
 * key is a plain object, not a wrapper — the rule `isSecretWrapper` already states.
 */
export function isEnvWrapper(value: unknown): value is EnvWrapper {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    hasOnlyEnvKey(value) &&
    typeof (value as EnvWrapper).$env === "string"
  );
}

function childPath(path: string, segment: string | number): string {
  return path === "" ? String(segment) : `${path}.${segment}`;
}

/**
 * Deep-walks a value and replaces every `$env` wrapper in it with whatever `visit` returns for that
 * variable name, leaving every other leaf untouched. `path` is the dot-path the wrapper was found
 * under, extended from `basePath` with object keys and array indices as segments.
 *
 * Same contract as `mapSecrets`, deliberately: a wrapper may sit at any nesting depth rather than
 * only at the leaf a dot-path lands on, and the wrapper's own string is the variable name, not more
 * structure, so it is not walked into.
 *
 * A `$secret` wrapper is walked *through* without becoming a path segment: the marking annotates
 * the value at that path rather than adding a level of structure, so `{a: {$secret: {$env: "N"}}}`
 * reports `a` — the same path `mapSecrets` reports for `{a: {$secret: "s"}}`. The marking is left
 * standing over the resolved value, which is what makes the composed form both usable and masked.
 */
export function mapEnv(
  value: JsonValue,
  visit: (name: string, path: string) => JsonValue,
  basePath = "",
): JsonValue {
  if (isEnvWrapper(value)) return visit(value.$env, basePath);
  if (value !== null && typeof value === "object" && !Array.isArray(value) && hasOnlyKey(value, "$secret")) {
    return { $secret: mapEnv((value as { $secret: JsonValue }).$secret, visit, basePath) };
  }
  if (Array.isArray(value)) return value.map((item, i) => mapEnv(item, visit, childPath(basePath, i)));
  if (value !== null && typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = mapEnv(item, visit, childPath(basePath, key));
    }
    return result;
  }
  return value;
}
