import { WorkerSchema } from "@path/schema";
import { z } from "zod";

/**
 * The typed log-event stream (mvp spec §8.1). Every event shares an envelope — `seq` (monotonic
 * per **root run**, the ordering truth since timestamps collide under parallelism), `ts`, `type`
 * (this flat discriminated union), `run_id`, and `node_id` — plus a per-type payload.
 *
 * This ticket (#19) lands the two step-lifecycle events; later construct tickets extend the union
 * with control-node events (`branch-taken`, `iteration-started`, `join-applied`, …). Because it is
 * a flat discriminated union, adding a member never touches the envelope or existing members.
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

export const LogEventSchema = z.discriminatedUnion("type", [StepStartedSchema, StepFinishedSchema]);

export type LogEvent = z.infer<typeof LogEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedSchema>;
export type StepFinishedEvent = z.infer<typeof StepFinishedSchema>;
