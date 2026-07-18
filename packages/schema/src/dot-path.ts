/**
 * Shared dot-path grammar for both `${}` interpolation (workflow-format-v0.md §5) and the
 * condition language (§9): `root(.segment)*`, segments are identifiers or numeric array indices,
 * no wildcards.
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
