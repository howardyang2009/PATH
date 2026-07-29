import type { SecretWrapper } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";

/**
 * What a `{"$secret": "<value>"}` config value *is* (workflow-format-v0.md §8.3), in one place:
 * the shape, and the fact that one may sit at any depth inside a config value.
 *
 * Both readers of a secret are policies over this walk rather than walks of their own — the engine
 * unwraps them for the worker (`interpolate.ts`) and collects them for the masker
 * (`secret-mask.ts`). They used to spell the predicate identically under two names and walk the
 * structure twice, in two modules, neither importing the schema that already defined the shape;
 * secrecy is an invariant, so the two could disagree about where a wrapper may sit and nothing
 * would say so.
 */

/**
 * True when `$secret` is the object's only key — the sole-key rule on its own, regardless of what
 * the key holds. `@path/schema`-internal: it exists so `ConfigValueSchema` can reject a sole-key
 * `$secret` object whose value is not a string rather than letting it pass as an ordinary object
 * with an oddly-named key.
 */
export function hasOnlySecretKey(value: object): boolean {
  return Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, "$secret");
}

/**
 * True when the value is a well-formed wrapper. A multi-key object that merely happens to carry a
 * `$secret` key is a plain object, not a wrapper.
 */
export function isSecretWrapper(value: unknown): value is SecretWrapper {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    hasOnlySecretKey(value) &&
    typeof (value as SecretWrapper).$secret === "string"
  );
}

function childPath(path: string, segment: string | number): string {
  return path === "" ? String(segment) : `${path}.${segment}`;
}

/**
 * Deep-walks a value and replaces every `$secret` wrapper in it with whatever `visit` returns for
 * that secret, leaving every other leaf untouched. `path` is the dot-path the wrapper was found
 * under, extended from `basePath` with object keys and array indices as segments.
 *
 * A wrapper can sit at any nesting depth, not only at the leaf a dot-path lands on: a bare-root or
 * ancestor interpolation (`${config}`, `${config.nested}`) resolves to a whole sub-tree, and a
 * secret declared anywhere inside it is still a secret. Walking only the addressed leaf is how a
 * worker ends up seeing the wrapper shape instead of the real value depending on how the path
 * happened to address it.
 *
 * The wrapper's own string is not walked into — it is the secret, not more structure.
 */
export function mapSecrets(
  value: JsonValue,
  visit: (secret: string, path: string) => JsonValue,
  basePath = "",
): JsonValue {
  if (isSecretWrapper(value)) return visit(value.$secret, basePath);
  if (Array.isArray(value)) return value.map((item, i) => mapSecrets(item, visit, childPath(basePath, i)));
  if (value !== null && typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = mapSecrets(item, visit, childPath(basePath, key));
    }
    return result;
  }
  return value;
}
