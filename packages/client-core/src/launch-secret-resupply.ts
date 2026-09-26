import { valueAtConfigPath, type JsonValue } from "@path/schema";
import { parseJsonField, type JsonFieldResult } from "./launch-json.js";

/**
 * The client half of the launch-facts secret-restore rule (ADR 0046), in one place. A continuation —
 * a Resume or a Complete — recovers the launch's frozen config, but a `$secret` value was frozen only
 * as its `[secret:<key>]` token, so the operator has to enter those values again or the engine falls
 * through to the environment (or fails the run before its first step). The two continuation surfaces
 * (`ResumeActions`, `CompleteForm`) share this whole contract rather than each re-deriving it:
 *
 * - `launchSecretResupply` — whether the config field must show, and the skeleton to prefill it with.
 * - `resupplyGate` — given the operator's config draft, the one verdict both surfaces gate on: the
 *   parse result, the still-blank secret paths, whether the draft may submit, and the block message.
 *
 * The engine remains the authority (a race, an unset `$env`, a rejected override still land as a
 * server error); this only keeps a request from being spent on a draft the client can already prove
 * cannot continue. The dot-paths read the same nesting `secretSkeletonJson` writes.
 */

/** The submitting continuation, so a block message reads in place ("…before resuming/completing."). */
export type ContinuationVerb = "resuming" | "completing";

/**
 * The config field's initial state for a continuation. When the launch recorded `$secret` config the
 * field must show, prefilled with the masked paths' skeleton so the operator fills values rather than
 * retyping the shape; otherwise there is nothing to re-enter.
 */
export interface LaunchSecretResupply {
  /** True when the launch recorded `$secret` config — the config field shows and opens by default. */
  required: boolean;
  /** The prefill for the config field: the nested skeleton, or `""` when nothing must be re-supplied. */
  skeleton: string;
}

/** Resolve the config field's initial show/skeleton state from the tree's recorded secret dot-paths. */
export function launchSecretResupply(keys: readonly string[]): LaunchSecretResupply {
  return keys.length > 0 ? { required: true, skeleton: secretSkeletonJson(keys) } : { required: false, skeleton: "" };
}

/**
 * The one verdict a continuation surface gates its submit on, computed from the operator's config
 * draft. `configResult` is the JSON parse (an invalid draft is the config field's own lint, so
 * `blockMessage` stays `null` for it — the field, not a form-level note, shows the reason). `blankPaths`
 * are the recorded secret paths still masked, absent, or blank. `ok` is true only when the draft parses
 * and leaves no blank secret. `blockMessage` is the single form-level sentence for a blank secret,
 * worded for the verb, or `null` when nothing at the secret level blocks.
 */
export interface ResupplyGate {
  configResult: JsonFieldResult;
  blankPaths: readonly string[];
  ok: boolean;
  blockMessage: string | null;
}

/** Compute the {@link ResupplyGate} for one continuation's config draft against its recorded secrets. */
export function resupplyGate(keys: readonly string[], configText: string, verb: ContinuationVerb): ResupplyGate {
  const configResult = parseJsonField(configText, { allowEmpty: true });
  const blankPaths = configResult.ok ? blankSecretPaths(keys, configResult.value) : [];
  return {
    configResult,
    blankPaths,
    ok: configResult.ok && blankPaths.length === 0,
    blockMessage: blankPaths.length > 0 ? blankSecretMessage(blankPaths, verb) : null,
  };
}

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
    const value = valueAtConfigPath(supplied, key);
    return typeof value !== "string" || value.trim() === "";
  });
}

/**
 * The operator-facing reason a continuation waits while a recorded secret path is blank: names each
 * one, singular or plural. The verb makes the sentence read in place — the Complete form's
 * "…before completing." and the Resume card's "…before resuming."
 */
export function blankSecretMessage(paths: readonly string[], verb: ContinuationVerb): string {
  const names = paths.map((path) => `"${path}"`).join(", ");
  return paths.length === 1
    ? `Launch secret ${names} is empty — enter a value before ${verb}.`
    : `Launch secrets ${names} are empty — enter a value for each before ${verb}.`;
}
