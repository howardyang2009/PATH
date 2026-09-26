import {
  type ConfigObject,
  type ConfigValue,
  type JsonValue,
  type LaunchFacts,
  mapSecrets,
} from "@path/schema";
import type { Trace } from "./condition.js";
import type { Observation } from "./run-observer.js";

/**
 * Secret masking at the persistence boundary (mvp spec §8.3): artifacts are scrubbed *by value*
 * before crossing the observer seam, `[secret:<config-key>]` replacing each occurrence. Workers
 * still receive real values and a succeeded run returns its `output` unmasked.
 *
 * Documented limit: a transformed secret (base64 etc.) escapes string matching — accepted, no taint tracking.
 */

// Below this length masking would over-replace unrelated text, so warn rather than skip.
const MIN_SAFE_SECRET_LENGTH = 6;

interface SecretEntry {
  /** The config key path the secret was first collected under — the `<config-key>` in its token. */
  key: string;
  value: string;
  token: string;
}

export interface SecretMasker {
  readonly isEmpty: boolean;
  readonly warnings: string[];
  maskString(text: string): string;
  /** Deep-scrub every string leaf of a JSON value; non-string leaves pass through untouched. */
  maskValue(value: JsonValue): JsonValue;
}

// Collection only records; the mapped tree is discarded. The first key a value is seen under wins
// its token, so never overwrite an existing entry.
function collectFromValue(path: string, value: ConfigValue, into: Map<string, SecretEntry>): void {
  // ConfigValue and JsonValue are structurally compatible but not nominally assignable across unions.
  mapSecrets(
    value as unknown as JsonValue,
    (secret, secretPath) => {
      if (!into.has(secret))
        into.set(secret, { key: secretPath, value: secret, token: `[secret:${secretPath}]` });
      return secret;
    },
    path,
  );
}

/**
 * Collects every `$secret` value across the given config objects in order (earlier objects win a
 * duplicated value's token). Pass the effective config sources of the whole run tree.
 */
export function collectSecrets(configs: ConfigObject[]): SecretMasker {
  const map = new Map<string, SecretEntry>();
  for (const config of configs) {
    for (const [key, value] of Object.entries(config)) collectFromValue(key, value, map);
  }

  // Longest first, so a secret that is a substring of another is scrubbed after its container.
  const entries = [...map.values()].sort((a, b) => b.value.length - a.value.length);

  const warnings = entries
    .filter((entry) => entry.value.length < MIN_SAFE_SECRET_LENGTH)
    .map(
      (entry) =>
        `secret "${entry.key}" is only ${entry.value.length} character(s) long — too short to mask reliably, ` +
        `it may over-replace unrelated text in persisted artifacts`,
    );

  function maskString(text: string): string {
    let out = text;
    for (const entry of entries) {
      // `{"$secret": {"$env": "FOO"}}` with `FOO=` resolves to "", a set empty value; split("") would
      // explode every character, and the short-secret warning above already flags it.
      if (entry.value.length === 0) continue;
      out = out.split(entry.value).join(entry.token);
    }
    return out;
  }

  function maskValue(value: JsonValue): JsonValue {
    if (typeof value === "string") return maskString(value);
    if (Array.isArray(value)) return value.map(maskValue);
    if (value !== null && typeof value === "object") {
      const result: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(value)) result[key] = maskValue(item);
      return result;
    }
    return value;
  }

  return { isEmpty: entries.length === 0, warnings, maskString, maskValue };
}

/** Scrubs a condition trace's `value` leaves and `message`: a condition reads the `context` and
 * `output` roots, so a trace can carry a published secret (mvp spec §8.1). */
function maskTrace(masker: SecretMasker, trace: Trace): Trace {
  if (trace.type === "all" || trace.type === "any") {
    return { ...trace, of: trace.of.map((child) => maskTrace(masker, child)) };
  }
  if (trace.type === "not") return { ...trace, of: maskTrace(masker, trace.of) };
  return {
    ...trace,
    ...(trace.value !== undefined ? { value: masker.maskValue(trace.value) } : {}),
    ...(trace.message !== undefined ? { message: masker.maskString(trace.message) } : {}),
  };
}

/** Scrubs one observation before it crosses the seam (mvp spec §8.3); total over the union **by
 * construction** — the `never` guard forces a decision for every new `Observation` member. */
export function maskObservation(masker: SecretMasker, o: Observation): Observation {
  switch (o.type) {
    case "run-started":
      // The frozen launch facts (ADR 0046) carry the operator's config override, which may hold a secret.
      return {
        ...o,
        input: masker.maskValue(o.input),
        ...(o.launchFacts === undefined
          ? {}
          : {
              launchFacts: masker.maskValue(o.launchFacts as unknown as JsonValue) as LaunchFacts,
            }),
      };
    case "step-started":
      return { ...o, input: masker.maskValue(o.input) };
    case "step-stderr":
      return { ...o, stderr: masker.maskString(o.stderr) };
    case "context-changed":
    case "step-context":
      return { ...o, context: masker.maskValue(o.context) };
    case "step-finished":
    case "run-finished":
      if (o.status === "succeeded") return { ...o, output: masker.maskValue(o.output) };
      if (o.status === "failed" && o.error !== undefined)
        return { ...o, error: masker.maskString(o.error) };
      return o;
    case "checkpoint-evaluated":
    case "iteration-started":
    case "loop-exited":
      return { ...o, trace: maskTrace(masker, o.trace) };
    case "branch-taken":
      return o.trace === null ? o : { ...o, trace: maskTrace(masker, o.trace) };
    case "branch-no-match":
      return { ...o, traces: o.traces.map((trace) => maskTrace(masker, trace)) };
    // `usage` is the worker's own report, stored verbatim on the run row (§5.7); scrubbed like any other payload.
    case "step-usage":
      return o.usage === null ? o : { ...o, usage: masker.maskValue(o.usage) };
    // No secret can reach these — every field is an id, count, context key, node id or engine-chosen enum (ADR 0061).
    case "join-applied":
    case "run-cancelled":
    case "reuse-marker":
    case "pass-started":
    case "goto-taken":
    case "goto-exhausted":
      return o;
    // `assignee` is an interpolated author value that can read `${config.x}`, so scrub it by value too.
    case "step-awaiting":
      return o.assignee === null ? o : { ...o, assignee: masker.maskString(o.assignee) };
    default: {
      const exhaustive: never = o;
      return exhaustive;
    }
  }
}
