import { mapSecrets, type ConfigObject, type ConfigValue, type JsonValue } from "@path/schema";
import type { Trace } from "./condition.js";
import type { Observation } from "./run-observer.js";

/**
 * Secret masking at the persistence boundary (mvp spec §8.3, ticket #20).
 *
 * A `{"$secret": "<value>"}` config value carries a real secret to workers and spawned processes,
 * but must never reach disk or a backend. At run start the engine collects every secret value in
 * effective config; then every persisted artifact — log events, input/output object files,
 * `context.json` write-throughs, the error a failed `step-finished` carries, captured stderr — is
 * string-scrubbed *by value* before it crosses the observer seam, each occurrence replaced with
 * `[secret:<config-key>]`. That event is the only *record* of a failed run's error — the run row has
 * status and no error column (#124) — though the text itself can also sit in `stderr.txt`, since a
 * binary step's error is the tail of its stderr. Masking is by value across every artifact for
 * exactly that reason: the same string reaches disk through more than one door.
 *
 * Masking is an audit-surface concern, not a dataflow restriction: the interpolated values handed
 * to workers stay real (see interpolate.ts), and a *succeeded* run returns its `output` — the run's
 * product — to the caller unmasked.
 *
 * One surface beyond the persistence boundary is scrubbed (#123): what a finished run hands back,
 * that product excepted. `RunResult.error` always, and `RunResult.output` when the run did not
 * succeed. The CLI prints both on its own stderr or stdout, which under `$env` is routinely a CI
 * build log — retained and read by people who never held the credential. `run-workflow.ts` applies
 * it at the run's return, where the masker already lives; nothing here is exported for a caller to
 * apply itself.
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
  /** True when no secrets were collected — the engine's emit can then skip masking entirely. */
  readonly isEmpty: boolean;
  /** Load-time warnings (e.g. a suspiciously short secret) surfaced once at run start. */
  readonly warnings: string[];
  /** Replace every occurrence of every secret value in a raw string with its token. */
  maskString(text: string): string;
  /** Deep-scrub every string leaf of a JSON value; non-string leaves pass through untouched. */
  maskValue(value: JsonValue): JsonValue;
}

// Where a `$secret` may sit is @path/schema's answer (`mapSecrets`); collection only says what to
// do when one is reached. The first key a given value is seen under wins its token (`same value
// under two keys → first key wins`), so never overwrite an existing entry. The mapped tree is
// discarded — this walk is here to record, not to transform.
function collectFromValue(path: string, value: ConfigValue, into: Map<string, SecretEntry>): void {
  // ConfigValue and JsonValue are structurally compatible (the `$secret` wrapper is just a plain
  // object shape) but not nominally assignable across their recursive unions.
  mapSecrets(
    value as unknown as JsonValue,
    (secret, secretPath) => {
      if (!into.has(secret)) into.set(secret, { key: secretPath, value: secret, token: `[secret:${secretPath}]` });
      return secret;
    },
    path,
  );
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
      // Reachable since `$env` sourcing (#116): `{"$secret": {"$env": "FOO"}}` with `FOO=` resolves
      // to "", an empty value being a set one. Skipping it is the only sane masking — split("")
      // would explode every character — and the short-secret warning above already flags it.
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
 * Scrub a condition trace: the `value` each leaf recorded and its explanatory `message`. Per mvp
 * spec §8.1 a leaf's value is recorded "post-masking" — a condition reads the `context` and
 * `output` roots, and a step can publish an interpolated secret into either, so a trace is as
 * capable of carrying one as an output object is.
 */
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

/**
 * Scrub one observation of every secret value before it crosses the seam into an observer — the
 * persistence boundary of mvp spec §8.3, applied at the engine's single emit choke point (#62).
 *
 * Total over the union **by construction**: the `never` guard means a new `Observation` member
 * cannot be added without deciding what masking owes it. That is the property this function exists
 * for. Its predecessor was a hand-written wrapper implementing 6 of 14 hooks, and the 8 it omitted
 * became silent no-ops for any workflow declaring a secret.
 *
 * Members carrying no string payload the engine did not itself construct — ids, worker bindings,
 * step types, counts, join keys — pass through untouched. Totality is not the same as coverage:
 * a member may be *listed* here and still return unmasked, so `test/mask-observation.test.ts`
 * carries a sample per member that really holds a secret, and names the members that provably
 * cannot hold one.
 */
export function maskObservation(masker: SecretMasker, o: Observation): Observation {
  switch (o.type) {
    case "run-started":
    case "step-started":
      return { ...o, input: masker.maskValue(o.input) };
    case "step-stderr":
      return { ...o, stderr: masker.maskString(o.stderr) };
    case "context-changed":
      return { ...o, context: masker.maskValue(o.context) };
    case "step-finished":
    case "run-finished":
      if (o.status === "succeeded") return { ...o, output: masker.maskValue(o.output) };
      if (o.status === "failed" && o.error !== undefined) return { ...o, error: masker.maskString(o.error) };
      return o;
    case "checkpoint-evaluated":
    case "iteration-started":
    case "loop-exited":
      return { ...o, trace: maskTrace(masker, o.trace) };
    case "branch-taken":
      return o.trace === null ? o : { ...o, trace: maskTrace(masker, o.trace) };
    case "branch-no-match":
      return { ...o, traces: o.traces.map((trace) => maskTrace(masker, trace)) };
    // `usage` is the worker's own report, stored verbatim on the run row (§5.7) — the one payload
    // here the engine neither built nor validated. Its documented content is token counts, and
    // numbers pass through masking untouched, so scrubbing it costs nothing and does not depend on
    // trusting a worker to keep it that way.
    case "step-usage":
      return o.usage === null ? o : { ...o, usage: masker.maskValue(o.usage) };
    // A secret cannot reach these: every field is an id, a count, a context key or a node id the
    // workflow author wrote, or an enum value the engine chose — none of them a config value.
    case "join-applied":
    case "run-cancelled":
      return o;
    default: {
      const exhaustive: never = o;
      return exhaustive;
    }
  }
}
