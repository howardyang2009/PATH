import type { JsonValue } from "@path/client-core";

/**
 * The prefill for a continuation's config field when the launch recorded `$secret` config (ADR 0046).
 * A frozen secret reads as its `[secret:<key>]` token, which the engine refuses to continue with — the
 * operator has to enter the values again. The skeleton nests each dot-path to an empty string, so the
 * field arrives as the shape to fill rather than a blank page: `["a.b"]` becomes `{"a":{"b":""}}`, the
 * same nesting the engine's config lookup reads.
 */
export function secretSkeletonJson(keys: readonly string[]): string {
  const skeleton: { [key: string]: JsonValue } = {};
  for (const key of keys) {
    const segments = key.split(".");
    let cursor = skeleton;
    // Every segment but the last is a container path; create it when absent, reuse it when present,
    // and replace it when a shorter key already made it a leaf.
    for (const segment of segments.slice(0, -1)) {
      const child = cursor[segment];
      if (typeof child === "object" && child !== null && !Array.isArray(child)) {
        cursor = child;
      } else {
        const nested: { [key: string]: JsonValue } = {};
        cursor[segment] = nested;
        cursor = nested;
      }
    }
    cursor[segments[segments.length - 1]!] = "";
  }
  return JSON.stringify(skeleton, null, 2);
}

/**
 * The recorded secret dot-paths a continuation's supplied config leaves unusable: absent, not a
 * string, or blank after trimming. A masked `[secret:<key>]` token cannot continue the run, and an
 * empty or whitespace value is no more a credential — the engine falls back to the environment and
 * continues, or fails the run before its first step. Asking the operator for a value before the
 * request is spent is the client-side half of that rule; the server still owns the outcome.
 * Dot-paths read the same nesting `secretSkeletonJson` writes.
 */
export function blankSecretPaths(keys: readonly string[], supplied: { [key: string]: JsonValue } | undefined): string[] {
  return keys.filter((key) => {
    const value = valueAtPath(supplied, key);
    return typeof value !== "string" || value.trim() === "";
  });
}

/**
 * The operator-facing reason a continuation waits while a recorded secret path is blank: names each
 * one, singular or plural. `action` is the submitting surface's verb, so the sentence reads in place —
 * the Complete form's "…before completing." and the Resume card's "…before resuming."
 */
export function blankSecretMessage(paths: readonly string[], action: "completing" | "resuming"): string {
  const names = paths.map((path) => `"${path}"`).join(", ");
  return paths.length === 1
    ? `Launch secret ${names} is empty — enter a value before ${action}.`
    : `Launch secrets ${names} are empty — enter a value for each before ${action}.`;
}

function valueAtPath(config: { [key: string]: JsonValue } | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = config;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? (current[index] as JsonValue | undefined) : undefined;
    } else {
      current = (current as { [key: string]: JsonValue })[segment];
    }
    if (current === undefined) return undefined;
  }
  return current;
}
