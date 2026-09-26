import type { JsonValue } from "./json-value.js";
import { isPlainObject } from "./wrapper.js";

/**
 * A **config dot-path**: the address `mapWrappers` writes for a value inside a config — object keys and
 * array indices as `.`-joined segments (`model.api_key`, `headers.0`). A frozen launch records where
 * its `$secret` values were by these paths (ADR 0046); the engine and the Viewer both read them, and
 * the engine rewrites them, through this one module, so an array segment means the same thing to both.
 */

/** The value at `path`, or `undefined` when any segment is absent. */
export function valueAtConfigPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current = value;
  for (const segment of path.split(".")) {
    current = childAt(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * `value` with the leaf at `path` replaced by `update(leaf)`, copying only the containers on the path.
 * Returned unchanged when the path does not exist.
 */
export function updateAtConfigPath(value: JsonValue, path: string, update: (leaf: JsonValue) => JsonValue): JsonValue {
  return updateAt(value, path.split("."), update);
}

function updateAt(value: JsonValue, segments: readonly string[], update: (leaf: JsonValue) => JsonValue): JsonValue {
  const [head, ...rest] = segments;
  if (head === undefined) return update(value);
  const child = childAt(value, head);
  if (child === undefined) return value;
  const next = updateAt(child, rest, update);
  if (Array.isArray(value)) return value.map((item, index) => (index === Number(head) ? next : item));
  return { ...(value as { [key: string]: JsonValue }), [head]: next };
}

/** One segment down: an object key, or an array index written as its number. */
function childAt(value: JsonValue | undefined, segment: string): JsonValue | undefined {
  if (Array.isArray(value)) {
    const index = Number(segment);
    return Number.isInteger(index) && index >= 0 ? value[index] : undefined;
  }
  if (isPlainObject(value)) return Object.hasOwn(value, segment) ? value[segment] : undefined;
  return undefined;
}
