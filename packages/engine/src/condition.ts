import { z } from "zod";
import type { Condition, JsonValue } from "@path/schema";

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
 * The `value` recorded in each leaf is "post-masking" per §8.1; secret masking is #20, so values
 * currently flow through unmasked, consistent with every other event in the stream today.
 */

export type ConditionOutcome = "true" | "false" | "error";

/** A leaf predicate's evaluation record: its dot-path, outcome, the value read, and (on a
 * non-true outcome) an explanatory message. */
export interface LeafTrace {
  type: "exists" | "equals" | "one-of" | "matches" | "range" | "valid-json";
  path: string;
  outcome: ConditionOutcome;
  value?: JsonValue;
  message?: string;
}
export interface AllTrace {
  type: "all";
  outcome: ConditionOutcome;
  of: Trace[];
}
export interface AnyTrace {
  type: "any";
  outcome: ConditionOutcome;
  of: Trace[];
}
export interface NotTrace {
  type: "not";
  outcome: ConditionOutcome;
  of: Trace;
}
export type Trace = LeafTrace | AllTrace | AnyTrace | NotTrace;

const OutcomeSchema = z.enum(["true", "false", "error"]);

const LeafTraceSchema = z
  .object({
    type: z.enum(["exists", "equals", "one-of", "matches", "range", "valid-json"]),
    path: z.string(),
    outcome: OutcomeSchema,
    // The read value is an already-validated JsonValue (it comes from resolving a dot-path over the
    // JsonValue roots); typed as such so TraceSchema is assignable to z.ZodType<Trace>.
    value: z.custom<JsonValue>().optional(),
    message: z.string().optional(),
  })
  .strict();

/** The trace as it rides the log-event stream (§8.1); mirrors the condition tree structurally. */
export const TraceSchema: z.ZodType<Trace> = z.lazy(() =>
  z.union([
    LeafTraceSchema,
    z.object({ type: z.literal("all"), outcome: OutcomeSchema, of: z.array(TraceSchema) }).strict(),
    z.object({ type: z.literal("any"), outcome: OutcomeSchema, of: z.array(TraceSchema) }).strict(),
    z.object({ type: z.literal("not"), outcome: OutcomeSchema, of: TraceSchema }).strict(),
  ]),
);

/** The two condition roots (format §9): `context` (written from inside) and `output` (the
 * predecessor node's output object, checkpoint-transparent per §5.4). */
export interface ConditionRoots {
  context: JsonValue;
  output: JsonValue;
}

export interface ConditionEvaluation {
  outcome: ConditionOutcome;
  trace: Trace;
}

interface ResolvedPath {
  found: boolean;
  value?: JsonValue;
  error?: string;
}

// Resolve a condition dot-path over the roots WITHOUT throwing — unlike ${} interpolation an
// unresolvable path is data the evaluator reports (an `exists` false, or a strict error leaf),
// not an exception. Syntax + roots are already load-time validated (format §9, dot-path.ts).
function resolvePath(roots: ConditionRoots, path: string): ResolvedPath {
  const segments = path.split(".");
  const root = segments[0];
  if (root !== "context" && root !== "output") {
    return { found: false, error: `invalid condition root "${root}"` };
  }
  let current: JsonValue = roots[root];
  for (const segment of segments.slice(1)) {
    if (current === null || typeof current !== "object") {
      return { found: false, error: `segment "${segment}" reaches into a non-object value` };
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, error: `index "${segment}" is out of bounds` };
      }
      current = current[index] as JsonValue;
    } else if (Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as { [key: string]: JsonValue })[segment] as JsonValue;
    } else {
      return { found: false, error: `key "${segment}" not found` };
    }
  }
  return { found: true, value: current };
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
  const resolved = resolvePath(roots, path);

  if (condition.type === "exists") {
    return resolved.found
      ? { ...base, outcome: "true", value: resolved.value }
      : { ...base, outcome: "false", message: `path "${path}" does not resolve` };
  }

  // Every other predicate reads a value: an unresolvable path is a strict error, not a false.
  if (!resolved.found) {
    return { ...base, outcome: "error", message: `path "${path}" does not resolve: ${resolved.error}` };
  }
  const value = resolved.value as JsonValue;

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
      const outcome: ConditionOutcome = of.outcome === "error" ? "error" : of.outcome === "true" ? "false" : "true";
      return { type: "not", outcome, of };
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
