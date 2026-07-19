import { WorkerSchema } from "@path/schema";
import { z } from "zod";
import { TraceSchema } from "../condition.js";

/**
 * The typed log-event stream (mvp spec §8.1). Every event shares an envelope — `seq` (monotonic
 * per **root run**, the ordering truth since timestamps collide under parallelism), `ts`, `type`
 * (this flat discriminated union), `run_id`, and `node_id` — plus a per-type payload.
 *
 * #19 landed the two step-lifecycle events; #21 adds the checkpoint/branch control-node events
 * (each carrying a condition `trace`, §8.1). Later construct tickets extend the union further
 * (`iteration-started`, `join-applied`, …). Because it is a flat discriminated union, adding a
 * member never touches the envelope or existing members.
 *
 * Control events are attributed to the enclosing workflow-step's run (`run_id`) + the control
 * node's own id (`node_id`) — §8.1; the engine has no run for a control node (invariant 1).
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

// Checkpoint asserts (spec §5.2): the condition's `trace` is the whole record — a strict-error
// evaluation surfaces as an error leaf inside it, `checkpoint-failed` covers both false and error.
const CheckpointPassedSchema = z.object({ type: z.literal("checkpoint-passed"), ...envelope, trace: TraceSchema }).strict();
const CheckpointFailedSchema = z.object({ type: z.literal("checkpoint-failed"), ...envelope, trace: TraceSchema }).strict();

// Branch routes (§5.2, §5.4). `branch-taken` names the winning arm — its index, or `"else"` (the
// fallback has no condition, so `trace` is null there); `branch-no-match` carries every arm's
// trace since none matched and there was no else (which fails the run).
const BranchTakenSchema = z
  .object({
    type: z.literal("branch-taken"),
    ...envelope,
    arm: z.union([z.number().int().nonnegative(), z.literal("else")]),
    trace: TraceSchema.nullable(),
  })
  .strict();
const BranchNoMatchSchema = z.object({ type: z.literal("branch-no-match"), ...envelope, traces: z.array(TraceSchema) }).strict();

export const LogEventSchema = z.discriminatedUnion("type", [
  StepStartedSchema,
  StepFinishedSchema,
  CheckpointPassedSchema,
  CheckpointFailedSchema,
  BranchTakenSchema,
  BranchNoMatchSchema,
]);

export type LogEvent = z.infer<typeof LogEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedSchema>;
export type StepFinishedEvent = z.infer<typeof StepFinishedSchema>;
