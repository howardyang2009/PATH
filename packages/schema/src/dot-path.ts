import type { JsonValue } from "./json-value.js";

/**
 * Shared dot-path grammar for both `${}` interpolation (workflow-format-v0.md §5) and the
 * condition language (§9): `root(.segment)*`, segments are identifiers or numeric array indices,
 * no wildcards.
 *
 * Two operations over one grammar, as siblings: `checkDotPath` decides whether a path is *writable*
 * at load time, `resolveDotPath` walks it against real values at run time. They were previously in
 * different packages, and the walk existed twice in the engine — once returning a result for the
 * condition evaluator, once throwing for interpolation — wording identical failures differently.
 */
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

/**
 * The outcome of walking a path against real values. `found: false` is not necessarily an error —
 * the `exists` condition treats an unresolvable path as a plain `false` (mvp spec §5.2) — so the
 * distinction between "absent" and "a problem" is the caller's to make. `error` always says why the
 * walk stopped, for the caller that does treat it as one.
 */
export type DotPathResolution = { found: true; value: JsonValue } | { found: false; error: string };

/**
 * Walks a validated dot-path against a set of roots. Array segments must be in-bounds integer
 * indices; object segments must be own properties, so an inherited or prototype key never resolves.
 *
 * The path's *syntax* is assumed valid (`checkDotPath`, at load time); what this reports on is
 * whether the values are there. `error` names the *segment* that stopped the walk and not the whole
 * path, because the caller already knows the path and frames the failure its own way — the
 * condition evaluator as a trace leaf, interpolation as a thrown `InterpolationError`.
 */
export function resolveDotPath(roots: { readonly [root: string]: JsonValue }, path: string): DotPathResolution {
  const segments = path.split(".");
  const root = segments[0];

  if (root === undefined || !Object.prototype.hasOwnProperty.call(roots, root)) {
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
    } else if (Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as { [key: string]: JsonValue })[segment] as JsonValue;
    } else {
      return { found: false, error: `key "${segment}" not found` };
    }
  }
  return { found: true, value: current };
}
