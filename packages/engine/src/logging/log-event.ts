import { WorkerSchema } from "@path/schema";
import { z } from "zod";

/**
 * The typed log-event stream (mvp spec §8.1). Every event shares an envelope — `seq` (monotonic
 * per **root run**, the ordering truth since timestamps collide under parallelism), `ts`, `type`
 * (this flat discriminated union), `run_id`, and `node_id` — plus a per-type payload.
 *
 * Ticket #19 landed the two step-lifecycle events; #24 adds the two parallel-block control events
 * (`join-applied`, `run-cancelled`). Later construct tickets extend the union further
 * (`branch-taken`, `iteration-started`, …). Because it is a flat discriminated union, adding a
 * member never touches the envelope or existing members.
 *
 * `node_id` is nullable: the top-level workflow is wrapped in an implicit root step (invariant 2)
 * that has no node id of its own — its lifecycle events carry a null `node_id`.
 */
const envelope = {
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  run_id: z.string(),
  node_id: z.string().nullable(),
};

const StepStartedSchema = z
  .object({
    type: z.literal("step-started"),
    ...envelope,
    step_type: z.string(),
    worker: WorkerSchema,
  })
  .strict();

const StepFinishedSchema = z
  .object({
    type: z.literal("step-finished"),
    ...envelope,
    status: z.enum(["succeeded", "failed", "cancelled"]),
    // Present only on a non-success outcome. For a binary step this message carries the exit code
    // and a short stderr tail (mvp spec §8.1); the full stderr lives in a blob (§6).
    error: z.string().optional(),
  })
  .strict();

// A `parallel` collect join applied at block end (mvp spec §5.2–5.4, §8.1): control events carry
// the enclosing workflow-step's run id + the `parallel` node's id (envelope), plus the branch ids
// in apply order and the context keys those branches published.
const JoinAppliedSchema = z
  .object({
    type: z.literal("join-applied"),
    ...envelope,
    branches: z.array(z.string()),
    published_keys: z.array(z.string()),
  })
  .strict();

// A run cancelled because a sibling parallel branch failed (mvp spec §5.6, §8.1): `run_id`/`node_id`
// identify the cancelled run and its node; `cause_run_id` is the failing sibling run that triggered
// the best-effort cancellation.
const RunCancelledSchema = z
  .object({
    type: z.literal("run-cancelled"),
    ...envelope,
    cause_run_id: z.string(),
  })
  .strict();

export const LogEventSchema = z.discriminatedUnion("type", [
  StepStartedSchema,
  StepFinishedSchema,
  JoinAppliedSchema,
  RunCancelledSchema,
]);

export type LogEvent = z.infer<typeof LogEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedSchema>;
export type StepFinishedEvent = z.infer<typeof StepFinishedSchema>;
export type JoinAppliedEvent = z.infer<typeof JoinAppliedSchema>;
export type RunCancelledEvent = z.infer<typeof RunCancelledSchema>;
