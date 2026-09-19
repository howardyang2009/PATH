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
