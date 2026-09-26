import { type JsonValue, valueAtConfigPath } from "@path/schema";
import { type JsonFieldResult, parseJsonField } from "./launch-json.js";

/** The client half of the launch-facts secret-restore rule (ADR 0046): a continuation recovers the
 * launch's frozen config, but a `$secret` value was frozen only as its `[secret:<key>]` token, so the
 * operator must enter it again. The engine remains the authority; this only keeps a doomed request
 * from being spent. The dot-paths read the same nesting `secretSkeletonJson` writes.
 */

export type ContinuationVerb = "resuming" | "completing";

/** The config field's initial state for a continuation: `required` when the launch recorded `$secret` config, with the
 * masked paths' skeleton as the prefill.
 */
export interface LaunchSecretResupply {
  required: boolean;
  skeleton: string;
}

/** Resolve the config field's initial show/skeleton state from the tree's recorded secret dot-paths. */
export function launchSecretResupply(keys: readonly string[]): LaunchSecretResupply {
  return keys.length > 0
    ? { required: true, skeleton: secretSkeletonJson(keys) }
    : { required: false, skeleton: "" };
}

/** The one verdict a continuation surface gates its submit on: `configResult` is the JSON parse (an invalid draft is
 * the field's own lint, so `blockMessage` stays `null` for it), `blankPaths` the recorded secret paths still blank,
 * and `ok` true only when the draft parses with no blank secret.
 */
export interface ResupplyGate {
  configResult: JsonFieldResult;
  blankPaths: readonly string[];
  ok: boolean;
  blockMessage: string | null;
}

/** Compute the {@link ResupplyGate} for one continuation's config draft against its recorded secrets. */
export function resupplyGate(
  keys: readonly string[],
  configText: string,
  verb: ContinuationVerb,
): ResupplyGate {
  const configResult = parseJsonField(configText, { allowEmpty: true });
  const blankPaths = configResult.ok ? blankSecretPaths(keys, configResult.value) : [];
  return {
    configResult,
    blankPaths,
    ok: configResult.ok && blankPaths.length === 0,
    blockMessage: blankPaths.length > 0 ? blankSecretMessage(blankPaths, verb) : null,
  };
}

/** The config-field prefill when the launch recorded `$secret` config (ADR 0046): the skeleton nests each dot-path to
 * an empty string — `["a.b"]` becomes `{"a":{"b":""}}` — so the field arrives as the shape to fill, the same nesting
 * the engine's config lookup reads.
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

/** The recorded secret dot-paths a supplied config leaves unusable — absent, not a string, or blank after trimming.
 * The masked token is no credential, so asking before the request is spent is the client-side half of the rule; the
 * server owns the outcome.
 */
export function blankSecretPaths(
  keys: readonly string[],
  supplied: { [key: string]: JsonValue } | undefined,
): string[] {
  return keys.filter((key) => {
    const value = valueAtConfigPath(supplied, key);
    return typeof value !== "string" || value.trim() === "";
  });
}

/** The operator-facing reason a continuation waits while a recorded secret path is blank: names each one, singular or
 * plural, with the verb making the sentence read in place.
 */
export function blankSecretMessage(paths: readonly string[], verb: ContinuationVerb): string {
  const names = paths.map((path) => `"${path}"`).join(", ");
  return paths.length === 1
    ? `Launch secret ${names} is empty — enter a value before ${verb}.`
    : `Launch secrets ${names} are empty — enter a value for each before ${verb}.`;
}
