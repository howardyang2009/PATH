import type { Message } from "@path/i18n";
import { type JsonValue, must, valueAtConfigPath } from "@path/schema";
import { type JsonFieldResult, parseJsonField } from "./launch-json.js";

/** The client half of the launch-facts secret-restore rule (ADR 0046): a continuation recovers the
 * launch's frozen config, but a `$secret` value was frozen only as its `[secret:<key>]` token, so
 * the operator must enter it again. The engine remains the authority; this only keeps a doomed
 * request from being spent. The dot-paths read the same nesting `secretSkeletonJson` writes.
 */

export type ContinuationVerb = "resuming" | "completing";

/** The config field's initial state for a continuation: `required` when the launch recorded
 * `$secret` config, with the masked paths' skeleton as the prefill.
 */
export interface LaunchSecretResupply {
  required: boolean;
  skeleton: string;
}

/** Resolve the config field's initial show/skeleton state from the tree's recorded secret
 * dot-paths. */
export function launchSecretResupply(keys: readonly string[]): LaunchSecretResupply {
  return keys.length > 0
    ? { required: true, skeleton: secretSkeletonJson(keys) }
    : { required: false, skeleton: "" };
}

/** The one reading every surface gates an `Override config` draft on: the JSON parse (an invalid
 * draft is the field's own lint, so `blockMessage` stays `null` for it), whether the draft asks for
 * anything at all, the recorded secret paths still blank, and whether the verb may submit.
 */
export interface OverrideReading {
  result: JsonFieldResult;
  /** The draft asks for nothing: blank text, or a literal `{}` — no keys to override with. */
  isEmpty: boolean;
  blankPaths: readonly string[];
  canSubmit: boolean;
  blockMessage: Message | null;
}

/** The draft one surface is reading: the text, the launch-secret dot-paths a continuation must
 * re-supply (empty for a launch), and the verb the blank-secret sentence reads in. */
export interface OverrideDraft {
  text: string;
  secretPaths?: readonly string[];
  verb?: ContinuationVerb;
}

/** Read one `Override config` draft: parse it, then gate it on the recorded launch secrets. */
export function readOverride(draft: OverrideDraft): OverrideReading {
  const secretPaths = draft.secretPaths ?? [];
  const result = parseJsonField(draft.text, { allowEmpty: true });
  const blankPaths = result.ok ? blankSecretPaths(secretPaths, result.value) : [];
  return {
    result,
    isEmpty: result.ok && Object.keys(result.value ?? {}).length === 0,
    blankPaths,
    canSubmit: result.ok && blankPaths.length === 0,
    blockMessage:
      blankPaths.length > 0
        ? blankSecretMessage(blankPaths, must(draft.verb, "a verb when a recorded secret is blank"))
        : null,
  };
}

/** The config-field prefill when the launch recorded `$secret` config (ADR 0046): the skeleton
 * nests each dot-path to an empty string — `["a.b"]` becomes `{"a":{"b":""}}` — so the field
 * arrives as the shape to fill, the same nesting the engine's config lookup reads.
 */
export function secretSkeletonJson(keys: readonly string[]): string {
  const skeleton: { [key: string]: JsonValue } = {};
  for (const key of keys) {
    const segments = key.split(".");
    const leaf = must(segments.pop(), "last key segment");
    let cursor = skeleton;
    // Every segment but the last is a container path; create it when absent, reuse it when present,
    // and replace it when a shorter key already made it a leaf.
    for (const segment of segments) {
      const child = cursor[segment];
      if (typeof child === "object" && child !== null && !Array.isArray(child)) {
        cursor = child;
      } else {
        const nested: { [key: string]: JsonValue } = {};
        cursor[segment] = nested;
        cursor = nested;
      }
    }
    cursor[leaf] = "";
  }
  return JSON.stringify(skeleton, null, 2);
}

/** The recorded secret dot-paths a supplied config leaves unusable — absent, not a string, or blank
 * after trimming. The masked token is no credential, so asking before the request is spent is the
 * client-side half of the rule; the server owns the outcome.
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

/** The operator-facing reason a continuation waits while a recorded secret path is blank: names
 * each one, singular or plural, with the verb making the sentence read in place.
 */
export function blankSecretMessage(paths: readonly string[], verb: ContinuationVerb): Message {
  const names = paths.map((path) => `"${path}"`).join(", ");
  return { key: "events.resupply.blankSecrets", params: { count: paths.length, names, verb } };
}
