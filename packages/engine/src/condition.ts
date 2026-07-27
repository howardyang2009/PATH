import { z } from "zod";
import {
  resolveDotPath,
  TraceSchema,
  type Condition,
  type ConditionOutcome,
  type ConditionRoot,
  type JsonValue,
  type LeafTrace,
  type Trace,
} from "@path/schema";

/**
 * The condition evaluator (mvp spec §5.2–5.4, §8.1; format §9). Evaluates a zod-validated
 * predicate tree against the roots `context`/`output` with **strict** error semantics, producing
 * a full **trace**: the tree annotated per node with its dot-path, outcome (`true`/`false`/`error`
 * + message), and the actual value read (CONTEXT.md "Trace").
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
 *
 * The `value` recorded in each leaf is "post-masking" per §8.1 — true since #62, which scrubs traces
 * along with every other observation at the engine's emit. Before that the trace-bearing hooks were
 * among the eight the masking wrapper never implemented, so no run masked one.
 */

// The trace *shape* lives in @path/schema (trace.ts) — it rides the log-event stream, so a reader
// replaying a run needs it without needing this evaluator. What lives here is what produces one.
export type { AllTrace, AnyTrace, ConditionOutcome, LeafTrace, NotTrace, Trace } from "@path/schema";
export { TraceSchema } from "@path/schema";

/**
 * The values a condition reads (format §9): `context` (written from inside) and `output` (the
 * predecessor node's output object, checkpoint-transparent per §5.4).
 *
 * Derived from `CONDITION_ROOTS` rather than restating it, so the deferred third root (`config`,
 * mvp spec §10) becomes one edit in @path/schema instead of three across two packages.
 */
export type ConditionRoots = { [K in ConditionRoot]: JsonValue };

export interface ConditionEvaluation {
  outcome: ConditionOutcome;
  trace: Trace;
}

function jsonType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
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
      : { ...base, outcome: "false", message: `path "${path}" does not resolve` };
  }

  // Every other predicate reads a value: an unresolvable path is a strict error, not a false.
  if (!resolved.found) {
    return { ...base, outcome: "error", message: `path "${path}" does not resolve: ${resolved.error}` };
  }
  const value = resolved.value;

  switch (condition.type) {
    case "equals":
      return { ...base, outcome: value === condition.value ? "true" : "false", value };
    case "one-of":
      return { ...base, outcome: condition.values.some((v) => v === value) ? "true" : "false", value };
    case "matches":
      if (typeof value !== "string") {
        return { ...base, outcome: "error", value, message: `"matches" requires a string value, got ${jsonType(value)}` };
      }
      return { ...base, outcome: new RegExp(condition.pattern).test(value) ? "true" : "false", value };
    case "range": {
      if (typeof value !== "number") {
        return { ...base, outcome: "error", value, message: `"range" requires a number value, got ${jsonType(value)}` };
      }
      const withinMin = condition.min === undefined || value >= condition.min;
      const withinMax = condition.max === undefined || value <= condition.max;
      return { ...base, outcome: withinMin && withinMax ? "true" : "false", value };
    }
    case "valid-json":
      if (typeof value !== "string") {
        return { ...base, outcome: "error", value, message: `"valid-json" requires a string value, got ${jsonType(value)}` };
      }
      try {
        JSON.parse(value);
        return { ...base, outcome: "true", value };
      } catch {
        return { ...base, outcome: "false", value, message: "value is not valid JSON" };
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
export function evaluateCondition(condition: Condition, roots: ConditionRoots): ConditionEvaluation {
  const trace = evaluate(condition, roots);
  return { outcome: trace.outcome, trace };
}

/**
 * A concise human reason a condition did not pass, pulled from the trace — the first `error`
 * leaf's message (strict-error case), else the first `false` leaf's, else a generic fallback.
 * Used to phrase checkpoint/branch run-failure messages.
 */
export function describeConditionFailure(trace: Trace): string {
  const errorLeaf = findLeaf(trace, "error");
  if (errorLeaf?.message) return errorLeaf.message;
  const falseLeaf = findLeaf(trace, "false");
  if (falseLeaf) return falseLeaf.message ?? `${falseLeaf.type} "${falseLeaf.path}" was false`;
  return "condition was not satisfied";
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
