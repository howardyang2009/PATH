import {
  type ConfigObject,
  type ConfigValue,
  type JsonValue,
  type LaunchFacts,
  mapSecrets,
} from "@path/schema";
import type { Trace } from "./condition.js";
import type { RunEvent, RunPayload, UnsequencedLogEvent } from "./run-observer.js";

/**
 * Secret masking at the persistence boundary (mvp spec §8.3): artifacts are scrubbed *by value*
 * before crossing the observer seam, `[secret:<config-key>]` replacing each occurrence. Workers
 * still receive real values and a succeeded run returns its `output` unmasked.
 *
 * Documented limit: a transformed secret (base64 etc.) escapes string matching — accepted, no taint
 * tracking.
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
  // ConfigValue and JsonValue are structurally compatible but not nominally assignable across
  // unions.
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
      // `{"$secret": {"$env": "FOO"}}` with `FOO=` resolves to "", a set empty value; split("")
      // would explode every character, and the short-secret warning above already flags it.
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

/** Scrubs one log event; total over `LogEvent` by construction via the `never` guard. */
function maskEvent(masker: SecretMasker, e: UnsequencedLogEvent): UnsequencedLogEvent {
  switch (e.type) {
    case "step-finished":
      return e.error === undefined ? e : { ...e, error: masker.maskString(e.error) };
    case "checkpoint-passed":
    case "checkpoint-failed":
    case "iteration-started":
    case "loop-exited":
      return { ...e, trace: maskTrace(masker, e.trace) };
    case "branch-taken":
      return e.trace === null ? e : { ...e, trace: maskTrace(masker, e.trace) };
    case "branch-no-match":
      return { ...e, traces: e.traces.map((trace) => maskTrace(masker, trace)) };
    // `assignee` is an interpolated author value that can read `${config.x}`, so scrub it by value
    // too.
    case "step-awaiting":
      return e.assignee === null ? e : { ...e, assignee: masker.maskString(e.assignee) };
    // No secret can reach these — every field is an id, name, count, context key or engine-chosen
    // enum (ADR 0061).
    case "step-started":
    case "join-applied":
    case "run-cancelled":
    case "reuse-marker":
    case "pass-started":
    case "goto-taken":
    case "goto-exhausted":
      return e;
    default: {
      const exhaustive: never = e;
      return exhaustive;
    }
  }
}

function maskPayload(masker: SecretMasker, p: RunPayload): RunPayload {
  switch (p.kind) {
    case "started":
      // The frozen launch facts (ADR 0046) carry the operator's config override, which may hold a
      // secret.
      return {
        ...p,
        input: masker.maskValue(p.input),
        ...(p.launchFacts === undefined
          ? {}
          : {
              launchFacts: masker.maskValue(p.launchFacts as unknown as JsonValue) as LaunchFacts,
            }),
      };
    case "output":
      return { ...p, output: masker.maskValue(p.output) };
    case "stderr":
      return { ...p, stderr: masker.maskString(p.stderr) };
    // `usage` is the worker's own report, stored verbatim on the run row (§5.7); scrubbed like any
    // other payload.
    case "usage":
      return p.usage === null ? p : { ...p, usage: masker.maskValue(p.usage) };
    case "context":
      return { ...p, context: masker.maskValue(p.context) };
    default: {
      const exhaustive: never = p;
      return exhaustive;
    }
  }
}

/** Scrubs one run event, its log event and its payload both, before it crosses the seam (mvp spec
 * §8.3). */
export function maskRunEvent(masker: SecretMasker, e: RunEvent): RunEvent {
  return {
    ...e,
    event: e.event === null ? null : maskEvent(masker, e.event),
    ...(e.payload === undefined ? {} : { payload: maskPayload(masker, e.payload) }),
  };
}
