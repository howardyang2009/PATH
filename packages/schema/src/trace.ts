import { z } from "zod";
import { LEAF_CONDITION_TYPES, type LeafConditionType } from "./condition-type.js";
import type { JsonValue } from "./json-value.js";

/**
 * The per-predicate evaluation record a condition produces (CONTEXT.md "Trace"; mvp spec §8.1,
 * format §9): the condition tree annotated per node with its dot-path, outcome, and the value read.
 *
 * The shape lives here rather than beside the evaluator because it is carried by the log-event
 * stream, and a reader of that stream — a viewer, a client, anything replaying a `run.log` — needs
 * the trace shape without needing the evaluator that produced it.
 *
 * A leaf's recorded `value` is **post-masking** (§8.1): the engine scrubs traces along with every
 * other observation before they cross into persistence.
 */
export type ConditionOutcome = "true" | "false" | "error";

/**
 * A leaf predicate's evaluation record: its dot-path, outcome, the value read, and (on a non-true
 * outcome) an explanatory message.
 */
export interface LeafTrace {
  /** Derived from `Condition`: a leaf trace is always the record of a leaf predicate. */
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
