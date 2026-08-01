import type { JsonValue } from "./json-value.js";

/**
 * What every `$`-prefixed config wrapper shares (workflow-format-v0.md §8.3, mvp-spec.md §8.3): the
 * sole-key rule that says what counts as one, and the descent that says where one may sit.
 *
 * Both live here because `$secret` and `$env` compose — `{"$secret": {"$env": "NAME"}}` is a value
 * that is both sourced and masked — so `secret.ts` and `env.ts` must agree about both. Agreement by
 * convention is what `secret.ts` was written to end: two hand-written walks drifted on where a
 * wrapper may sit, and nothing said so. Sharing the descent makes that agreement mechanical rather
 * than something paired tests have to keep true.
 */

/**
 * A wrapper is a *marking*, so the marker must be the object's only key. A multi-key object that
 * merely carries a `$secret` or `$env` field is a plain config object — otherwise an author's
 * ordinary object would silently become a wrapper the moment it grew a field with that name.
 */
export function hasOnlyKey<K extends string>(value: object, key: K): value is Record<K, JsonValue> {
  return soleKey(value) === key;
}

/**
 * The object's only key, or `undefined` when it has none or more than one — the same sole-key rule
 * read the other way round, for the caller that must answer *which* key rather than check a known
 * one. `ConfigValueSchema` needs it to reject a sole `$`-prefixed key it does not recognise, and
 * asking here keeps that rule stated once.
 */
export function soleKey(value: object): string | undefined {
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
}

/** A JSON object rather than an array or `null` — the only shape a wrapper can take. */
export function isPlainObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childPath(path: string, segment: string | number): string {
  return path === "" ? String(segment) : `${path}.${segment}`;
}

/**
 * Deep-walks a value and replaces every wrapper `match` claims with what it returns, leaving every
 * other leaf untouched. `path` is the dot-path the wrapper was found under, extended from `basePath`
 * with object keys and array indices as segments; `match` returns `undefined` for anything that is
 * not its wrapper, which is the signal to keep descending.
 *
 * A wrapper can sit at any nesting depth, not only at the leaf a dot-path lands on: a bare-root or
 * ancestor interpolation (`${config}`, `${config.nested}`) resolves to a whole sub-tree, and a
 * wrapper declared anywhere inside it still means what it means. Walking only the addressed leaf is
 * how a worker ends up seeing the wrapper shape instead of the real value depending on how the path
 * happened to address it.
 *
 * A claimed wrapper's own contents are not descended into here — `match` decides what, if anything,
 * inside one gets walked, because only it knows which part is structure and which is the value.
 */
export function mapWrappers(
  value: JsonValue,
  match: (value: JsonValue, path: string) => JsonValue | undefined,
  basePath = "",
): JsonValue {
  const matched = match(value, basePath);
  if (matched !== undefined) return matched;
  if (Array.isArray(value)) return value.map((item, i) => mapWrappers(item, match, childPath(basePath, i)));
  if (isPlainObject(value)) {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = mapWrappers(item, match, childPath(basePath, key));
    }
    return result;
  }
  return value;
}
