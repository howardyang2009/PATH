import { WorkerSchema } from "@path/schema";
import { z } from "zod";
import { TraceSchema } from "../condition.js";

/**
 * The typed log-event stream (mvp spec §8.1). Every event shares an envelope — `seq` (monotonic
 * per **root run**, the ordering truth since timestamps collide under parallelism), `ts`, `type`
 * (this flat discriminated union), `run_id`, and `node_id` — plus a per-type payload.
 *
 * #19 landed the two step-lifecycle events; #21 adds the checkpoint/branch control-node events
 * (each carrying a condition `trace`, §8.1); #24 adds the two parallel-block control events
 * (`join-applied`, `run-cancelled`). Later construct tickets extend the union further
 * (`iteration-started`, …). Because it is a flat discriminated union, adding a
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

// A run cancelled best-effort (mvp spec §5.6, §8.1): `run_id`/`node_id` identify the cancelled run
// and its node. `cause` says why — `sibling-failed` (a parallel branch failed) or `operator` (a
// cancel request against the root run, #52) — and `cause_run_id` is the failing sibling run, non-null
// exactly for `sibling-failed`.
//
// `cause` defaults to `sibling-failed`, the only cause that existed before #52: every persisted log
// line is re-validated on read (readNdjsonLog, getLogEventsForRoot), and that path feeds SSE replay,
// so a *required* field here would make every already-written `run.log` throw when an operator opens
// an old run. Old lines keep parsing, and read back as sibling-failed with their `cause_run_id`.
const RunCancelledSchema = z
  .object({
    type: z.literal("run-cancelled"),
    ...envelope,
    cause: z.enum(["sibling-failed", "operator"]).default("sibling-failed"),
    cause_run_id: z.string().nullable(),
  })
  .strict();

// While-do loops (mvp spec §5.2–5.4, §8.1): `iteration-started` fires before each iteration body
// with a 1-based `iteration` and the passing (true) condition trace; `loop-exited` fires once at
// block end with the exit `reason`, the completed `iterations` count, and the final condition trace.
const IterationStartedSchema = z
  .object({
    type: z.literal("iteration-started"),
    ...envelope,
    iteration: z.number().int().positive(),
    trace: TraceSchema,
  })
  .strict();
const LoopExitedSchema = z
  .object({
    type: z.literal("loop-exited"),
    ...envelope,
    reason: z.enum(["condition-false", "max-iterations-exceeded"]),
    iterations: z.number().int().nonnegative(),
    trace: TraceSchema,
  })
  .strict();

export const LogEventSchema = z.discriminatedUnion("type", [
  StepStartedSchema,
  StepFinishedSchema,
  CheckpointPassedSchema,
  CheckpointFailedSchema,
  BranchTakenSchema,
  BranchNoMatchSchema,
  JoinAppliedSchema,
  RunCancelledSchema,
  IterationStartedSchema,
  LoopExitedSchema,
]);

export type LogEvent = z.infer<typeof LogEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedSchema>;
export type StepFinishedEvent = z.infer<typeof StepFinishedSchema>;
export type JoinAppliedEvent = z.infer<typeof JoinAppliedSchema>;
export type RunCancelledEvent = z.infer<typeof RunCancelledSchema>;
