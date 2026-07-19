import type { ConfigObject, ConfigValue, JsonValue } from "@path/schema";
import type { RunObserver, RunOutcome } from "./run-observer.js";

/**
 * Secret masking at the persistence boundary (mvp spec §8.3, ticket #20).
 *
 * A `{"$secret": "<value>"}` config value carries a real secret to workers and spawned processes,
 * but must never reach disk or a backend. At run start the engine collects every secret value in
 * effective config; then every persisted artifact — log events, input/output object files,
 * `context.json` write-throughs, run-row error strings, captured stderr — is string-scrubbed *by
 * value* before it crosses the observer seam, each occurrence replaced with `[secret:<config-key>]`.
 *
 * Masking is an audit-surface concern, not a dataflow restriction: the interpolated values handed
 * to workers stay real (see interpolate.ts), and the `RunResult` returned to the caller is unmasked
 * — only the observer payloads (the persistence boundary) are scrubbed.
 *
 * Documented limits: a transformed secret (base64 etc.) escapes string matching — accepted, no taint
 * tracking. A very short secret risks mass false-replacement, so it triggers a load-time warning.
 */

// Below this length a secret is more noise than signal — masking it would over-replace unrelated
// text (a two-char secret "ab" would scrub every "ab" in every path). Warn rather than skip.
const MIN_SAFE_SECRET_LENGTH = 6;

interface SecretEntry {
  /** The config key path the secret was first collected under — the `<config-key>` in its token. */
  key: string;
  value: string;
  token: string;
}

export interface SecretMasker {
  /** True when no secrets were collected — the caller can skip wrapping the observer entirely. */
  readonly isEmpty: boolean;
  /** Load-time warnings (e.g. a suspiciously short secret) surfaced once at run start. */
  readonly warnings: string[];
  /** Replace every occurrence of every secret value in a raw string with its token. */
  maskString(text: string): string;
  /** Deep-scrub every string leaf of a JSON value; non-string leaves pass through untouched. */
  maskValue(value: JsonValue): JsonValue;
}

// The sole-key `{"$secret": "..."}` shape (config-value-type.ts). A multi-key object that merely
// happens to contain a `$secret` key is a plain object, not a wrapper.
function isSecretWrapper(value: ConfigValue): value is { $secret: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $secret?: unknown }).$secret === "string"
  );
}

// A `$secret` wrapper can sit at any depth in a config value, so walk the whole structure. The
// first key a given value is seen under wins its token (`same value under two keys → first key
// wins`), so never overwrite an existing entry.
function collectFromValue(path: string, value: ConfigValue, into: Map<string, SecretEntry>): void {
  if (isSecretWrapper(value)) {
    const secret = value.$secret;
    if (!into.has(secret)) into.set(secret, { key: path, value: secret, token: `[secret:${path}]` });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectFromValue(`${path}.${i}`, item, into));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectFromValue(`${path}.${key}`, item, into);
  }
}

/**
 * Collects every `$secret` value across the given config objects (in order — earlier objects win
 * the token key for a duplicated value) and returns a masker over them. Pass the effective config
 * sources of the whole run tree: operator config, each file's declared config, and each step's
 * config — secrecy rides a value through inheritance and operator overrides, so any of them may
 * introduce a secret.
 */
export function collectSecrets(configs: ConfigObject[]): SecretMasker {
  const map = new Map<string, SecretEntry>();
  for (const config of configs) {
    for (const [key, value] of Object.entries(config)) collectFromValue(key, value, map);
  }

  // Longest value first so a secret that is a substring of another is scrubbed after its container,
  // never leaving a half-masked token behind.
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
      // A zero-length value can't occur (schema requires a string, and a "" wrapper would loop),
      // but guard defensively — split("") would explode every character.
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

/**
 * Wraps a `RunObserver` so every payload crossing into it is scrubbed of secret values first — the
 * one choke point where the engine's audit surface (persistence #18 + logging #19) becomes the
 * persistence boundary. Every field the spec lists as persisted is masked: `input` (runStarted /
 * stepStarted), `stderr`, step/run `output` and `error` (the `RunOutcome`), and `context`. Fields
 * that never carry an interpolated secret (ids, worker binding, step type) pass through untouched.
 *
 * The wrapper preserves the inner observer's async contract and error propagation: an
 * `ObserverError` thrown by the inner observer (a log backend write failure) still surfaces so the
 * engine fails the run.
 */
export function createMaskingObserver(masker: SecretMasker, inner: RunObserver): RunObserver {
  function maskOutcome<T extends { runId: string; rootRunId: string } & RunOutcome>(info: T): T {
    if (info.status === "succeeded") return { ...info, output: masker.maskValue(info.output) };
    if (info.error !== undefined) return { ...info, error: masker.maskString(info.error) };
    return info;
  }

  // Each hook is async so a synchronously-thrown inner error normalizes to a rejection — the
  // engine only ever awaits these, and an `ObserverError` must propagate the same way whether the
  // inner observer throws sync or returns a rejected promise.
  return {
    async runStarted(info) {
      await inner.runStarted?.({ ...info, input: masker.maskValue(info.input) });
    },
    async stepStarted(info) {
      await inner.stepStarted?.({ ...info, input: masker.maskValue(info.input) });
    },
    async stepStderr(info) {
      await inner.stepStderr?.({ ...info, stderr: masker.maskString(info.stderr) });
    },
    async stepFinished(info) {
      await inner.stepFinished?.(maskOutcome(info));
    },
    async contextChanged(info) {
      await inner.contextChanged?.({ ...info, context: masker.maskValue(info.context) });
    },
    async runFinished(info) {
      await inner.runFinished?.(maskOutcome(info));
    },
  };
}
