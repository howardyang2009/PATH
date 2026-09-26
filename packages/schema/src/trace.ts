import { z } from "zod";
import { LEAF_CONDITION_TYPES, type LeafConditionType } from "./condition-type.js";
import type { JsonValue } from "./json-value.js";

/**
 * The per-predicate evaluation record a condition produces (CONTEXT.md "Trace"; mvp spec §8.1): the
 * condition tree annotated per node with its dot-path, outcome, and value. It lives here rather than
 * beside the evaluator because the log-event stream carries it. A leaf's `value` is post-masking.
 */
export type ConditionOutcome = "true" | "false" | "error";

/** A leaf predicate's record: dot-path, outcome, the value read, and a message on a non-true outcome. */
export interface LeafTrace {
  type: LeafConditionType;
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
    type: z.enum(LEAF_CONDITION_TYPES),
    path: z.string(),
    outcome: OutcomeSchema,
    // Already a validated JsonValue; typed as such so TraceSchema is assignable to z.ZodType<Trace>.
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
