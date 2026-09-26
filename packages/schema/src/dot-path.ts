import type { JsonValue } from "./json-value.js";

/** Shared dot-path grammar for `${}` interpolation (docs/format/workflow-format.md §6) and the condition
 * language (§9): `root(.segment)*`, identifier or numeric segments, no wildcards. `checkDotPath`
 * decides load-time writability; `resolveDotPath` walks real values over the same grammar. */
const SEGMENT_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_-]*|\d+)$/;

export interface DotPathCheckResult {
  ok: boolean;
  error?: string;
}

export function checkDotPath(path: string, allowedRoots: readonly string[]): DotPathCheckResult {
  if (path.length === 0) {
    return { ok: false, error: "empty path" };
  }

  const segments = path.split(".");
  const root = segments[0];

  if (!root || !allowedRoots.includes(root)) {
    return {
      ok: false,
      error: `invalid root "${root}" in "${path}" — must be one of ${allowedRoots.join(", ")}`,
    };
  }

  for (const segment of segments.slice(1)) {
    if (!SEGMENT_PATTERN.test(segment)) {
      return { ok: false, error: `malformed dot-path segment "${segment}" in "${path}"` };
    }
  }

  return { ok: true };
}

/** The walk's outcome. `found: false` is not necessarily an error — the `exists` condition treats an
 * unresolvable path as a plain `false` (mvp spec §5.2) — so the caller decides; `error` says why. */
export type DotPathResolution = { found: true; value: JsonValue } | { found: false; error: string };

/** Walks a validated path against `roots`: array segments must be in-bounds integer indices, object
 * segments own properties, so an inherited key never resolves. `error` names the segment that stopped
 * the walk, not the whole path — the caller already knows the path and frames the failure itself. */
export function resolveDotPath(
  roots: { readonly [root: string]: JsonValue },
  path: string,
): DotPathResolution {
  const segments = path.split(".");
  const root = segments[0];

  if (root === undefined || !Object.hasOwn(roots, root)) {
    return { found: false, error: `unknown root "${root ?? ""}"` };
  }

  let current: JsonValue = roots[root] as JsonValue;
  for (const segment of segments.slice(1)) {
    if (current === null || typeof current !== "object") {
      return { found: false, error: `"${segment}" reaches into a non-object value` };
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, error: `index "${segment}" is out of bounds` };
      }
      current = current[index] as JsonValue;
    } else if (Object.hasOwn(current, segment)) {
      current = (current as { [key: string]: JsonValue })[segment] as JsonValue;
    } else {
      return { found: false, error: `key "${segment}" not found` };
    }
  }
  return { found: true, value: current };
}
