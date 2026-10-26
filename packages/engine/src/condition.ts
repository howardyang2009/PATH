import { englishText, type Message, verbatim } from "@path/i18n";
import {
  type Condition,
  type ConditionOutcome,
  type JsonValue,
  type LeafTrace,
  resolveDotPath,
  type ScopeFor,
  type Trace,
} from "@path/schema";

/**
 * The condition evaluator (mvp spec §5.2–5.4, §8.1). Evaluates a predicate tree against the roots
 * `context`/`previous`, producing a full per-node trace: dot-path, outcome (`true`/`false`/`error` +
 * message) and the value read. Each leaf's value is post-masking (§8.1).
 *
 * Strict semantics — the distinction between a `false` and an `error` leaf:
 * - `exists` is the *only* predicate for which an unresolvable path is not an error: a missing path
 *   is simply `false` (it does not exist).
 * - Every value-reading predicate (`equals`, `one-of`, `matches`, `range`, `valid-json`) treats an
 *   unresolvable path as an `error` — you cannot assert about a value that is not there.
 * - A type mismatch on a predicate that requires a specific value type is an `error`: `matches`
 *   and `valid-json` require a string, `range` requires a number.
 * - Errors dominate combination: an `all`/`any` with any `error` child is itself `error`, and
 *   `not` of an `error` is `error`. An overall `error` fails the condition (spec §5.6).
 */

// The trace *shape* lives in @path/schema (trace.ts) — it rides the log-event stream, so a reader
// replaying a run needs it without needing this evaluator. What lives here is what produces one.
export type {
  AllTrace,
  AnyTrace,
  ConditionOutcome,
  LeafTrace,
  NotTrace,
  Trace,
} from "@path/schema";
export { TraceSchema } from "@path/schema";

/**
 * The values a condition reads (format §9): `context` (written from inside) and `previous` (the
 * predecessor node's output object, checkpoint-transparent per §5.4). Typed from `ROOTS`.
 */
export type ConditionRoots = ScopeFor<"condition">;

export interface ConditionEvaluation {
  outcome: ConditionOutcome;
  trace: Trace;
}

function jsonType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// The reason behind each leaf's English `message`, for {@link describeConditionFailure}: the trace
// schema carries only the text, and a trace is persisted, so the `Message` rides beside it.
const leafReasons = new WeakMap<LeafTrace, Message>();

function withReason(leaf: Omit<LeafTrace, "message">, reason: Message): LeafTrace {
  const trace: LeafTrace = { ...leaf, message: englishText(reason) };
  leafReasons.set(trace, reason);
  return trace;
}

function evaluateLeaf(
  condition: Extract<Condition, { path: string }>,
  roots: ConditionRoots,
): LeafTrace {
  const path = condition.path;
  const base = { type: condition.type, path } as const;
  const resolved = resolveDotPath(roots, path);

  if (condition.type === "exists") {
    return resolved.found
      ? { ...base, outcome: "true", value: resolved.value }
      : withReason(
          { ...base, outcome: "false" },
          { key: "errors.condition.unresolved", params: { path } },
        );
  }

  // Every other predicate reads a value: an unresolvable path is a strict error, not a false.
  if (!resolved.found) {
    return withReason(
      { ...base, outcome: "error" },
      {
        key: "errors.condition.unresolved-because",
        params: { path, reason: verbatim(resolved.error) },
      },
    );
  }
  const value = resolved.value;

  switch (condition.type) {
    case "equals":
      return { ...base, outcome: value === condition.value ? "true" : "false", value };
    case "one-of":
      return {
        ...base,
        outcome: condition.values.some((v) => v === value) ? "true" : "false",
        value,
      };
    case "matches":
      if (typeof value !== "string") {
        return withReason(
          { ...base, outcome: "error", value },
          {
            key: "errors.condition.wants-string",
            params: { predicate: "matches", got: jsonType(value) },
          },
        );
      }
      return {
        ...base,
        outcome: new RegExp(condition.pattern).test(value) ? "true" : "false",
        value,
      };
    case "range": {
      if (typeof value !== "number") {
        return withReason(
          { ...base, outcome: "error", value },
          { key: "errors.condition.wants-number", params: { got: jsonType(value) } },
        );
      }
      const withinMin = condition.min === undefined || value >= condition.min;
      const withinMax = condition.max === undefined || value <= condition.max;
      return { ...base, outcome: withinMin && withinMax ? "true" : "false", value };
    }
    case "valid-json":
      if (typeof value !== "string") {
        return withReason(
          { ...base, outcome: "error", value },
          {
            key: "errors.condition.wants-string",
            params: { predicate: "valid-json", got: jsonType(value) },
          },
        );
      }
      try {
        JSON.parse(value);
        return { ...base, outcome: "true", value };
      } catch {
        return withReason(
          { ...base, outcome: "false", value },
          { key: "errors.condition.invalid-json" },
        );
      }
  }
}

function combine(children: Trace[], kind: "all" | "any"): ConditionOutcome {
  if (children.some((c) => c.outcome === "error")) return "error";
  if (kind === "all") return children.every((c) => c.outcome === "true") ? "true" : "false";
  return children.some((c) => c.outcome === "true") ? "true" : "false";
}

// `not` inverts true/false but never masks an error — an error child stays an error (§5.6).
function negate(outcome: ConditionOutcome): ConditionOutcome {
  if (outcome === "error") return "error";
  return outcome === "true" ? "false" : "true";
}

function evaluate(condition: Condition, roots: ConditionRoots): Trace {
  switch (condition.type) {
    case "all": {
      const of = condition.of.map((c) => evaluate(c, roots));
      return { type: "all", outcome: combine(of, "all"), of };
    }
    case "any": {
      const of = condition.of.map((c) => evaluate(c, roots));
      return { type: "any", outcome: combine(of, "any"), of };
    }
    case "not": {
      const of = evaluate(condition.of, roots);
      return { type: "not", outcome: negate(of.outcome), of };
    }
    default:
      return evaluateLeaf(condition, roots);
  }
}

/** Evaluate a condition tree over the roots, returning the overall outcome and the full trace. */
export function evaluateCondition(
  condition: Condition,
  roots: ConditionRoots,
): ConditionEvaluation {
  const trace = evaluate(condition, roots);
  return { outcome: trace.outcome, trace };
}

/**
 * A concise human reason a condition did not pass, pulled from the trace — the first `error` leaf's
 * message (strict-error case), else the first `false` leaf's, else a generic fallback. Phrases the
 * checkpoint and branch run-failure messages.
 */
export function describeConditionFailure(trace: Trace): Message {
  const errorLeaf = findLeaf(trace, "error");
  if (errorLeaf?.message) return leafReason(errorLeaf, errorLeaf.message);
  const falseLeaf = findLeaf(trace, "false");
  if (falseLeaf?.message) return leafReason(falseLeaf, falseLeaf.message);
  if (falseLeaf) {
    return {
      key: "errors.condition.was-false",
      params: { predicate: falseLeaf.type, path: falseLeaf.path },
    };
  }
  return { key: "errors.condition.not-satisfied" };
}

// A leaf this module did not evaluate (e.g. one read back from a log) has only its text.
function leafReason(leaf: LeafTrace, message: string): Message {
  return leafReasons.get(leaf) ?? verbatim(message);
}

function findLeaf(trace: Trace, outcome: ConditionOutcome): LeafTrace | undefined {
  if (trace.type === "all" || trace.type === "any") {
    for (const child of trace.of) {
      const found = findLeaf(child, outcome);
      if (found) return found;
    }
    return undefined;
  }
  if (trace.type === "not") return findLeaf(trace.of, outcome);
  return trace.outcome === outcome ? trace : undefined;
}
