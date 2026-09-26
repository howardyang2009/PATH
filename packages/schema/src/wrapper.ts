import type { JsonValue } from "./json-value.js";

/**
 * What every `$`-prefixed config wrapper shares: the sole-key rule and the deep descent, shared because `$secret`
 * and `$env` compose.
 */

/** A wrapper's marker must be the object's only key; a multi-key object carrying `$secret` is plain config. */
export function hasOnlyKey<K extends string>(value: object, key: K): value is Record<K, JsonValue> {
  return soleKey(value) === key;
}

/** The object's only key, or `undefined` when it has none or more than one. */
export function soleKey(value: object): string | undefined {
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
}

export function isPlainObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childPath(path: string, segment: string | number): string {
  return path === "" ? String(segment) : `${path}.${segment}`;
}

/**
 * Deep-walks a value replacing every wrapper `match` claims; a wrapper may sit at any depth, so the whole tree is
 * walked.
 */
export function mapWrappers(
  value: JsonValue,
  match: (value: JsonValue, path: string) => JsonValue | undefined,
  basePath = "",
): JsonValue {
  const matched = match(value, basePath);
  if (matched !== undefined) return matched;
  if (Array.isArray(value))
    return value.map((item, i) => mapWrappers(item, match, childPath(basePath, i)));
  if (isPlainObject(value)) {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = mapWrappers(item, match, childPath(basePath, key));
    }
    return result;
  }
  return value;
}
