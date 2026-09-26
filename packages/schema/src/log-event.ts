import { z } from "zod";
import { TerminalRunStatusSchema } from "./run-status.js";
import { TraceSchema } from "./trace.js";

/** The typed log-event stream (mvp spec §8.1): a flat discriminated union sharing an envelope — `seq`
 * (monotonic per **root run**, the ordering truth since timestamps collide under parallelism), `ts`,
 * `type`, `run_id`, `node_id` (GUID) and `node_name` (label, ADR 0007) — plus a per-type payload.
 * Control events are attributed to the enclosing workflow-run + the control node's id; the implicit root
 * step (invariant 2) has no node, so its lifecycle events carry null ids. */
const envelope = {
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  run_id: z.string(),
  node_id: z.string().nullable(),
  node_name: z.string().nullable(),
};

const StepStartedSchema = z
  .object({
    type: z.literal("step-started"),
    ...envelope,
    step_type: z.string(),
    // The *name* of the worker the step ran on (ADR 0021 sub-14): a leaf carries its resolved name
    // (`spawn`/`anthropic`); a workflow-run's implicit-root-step event carries `"workflow"`.
    worker_name: z.string(),
  })
  .strict();

const StepFinishedSchema = z
  .object({
    type: z.literal("step-finished"),
    ...envelope,
    status: TerminalRunStatusSchema,
    // Present only on a non-success outcome; a binary step's carries the exit code and a stderr tail (§8.1).
    error: z.string().optional(),
  })
  .strict();

// Checkpoint asserts (spec §5.2): the trace is the whole record — `checkpoint-failed` covers false and error.
const CheckpointPassedSchema = z
  .object({ type: z.literal("checkpoint-passed"), ...envelope, trace: TraceSchema })
  .strict();
const CheckpointFailedSchema = z
  .object({ type: z.literal("checkpoint-failed"), ...envelope, trace: TraceSchema })
  .strict();

// Branch routes (§5.2, §5.4): `branch-taken` names the winning arm (its index, or `"else"`, whose
// trace is null); `branch-no-match` carries every arm's trace since none matched and there was no else.
const BranchTakenSchema = z
  .object({
    type: z.literal("branch-taken"),
    ...envelope,
    arm: z.union([z.number().int().nonnegative(), z.literal("else")]),
    trace: TraceSchema.nullable(),
  })
  .strict();
const BranchNoMatchSchema = z
  .object({ type: z.literal("branch-no-match"), ...envelope, traces: z.array(TraceSchema) })
  .strict();

// A `parallel` collect join applied at block end (§5.2–5.4): branch names in apply order, the context
// keys they published (names, not GUIDs — ADR 0007), and `winner` only for a `wait-one` join.
const JoinAppliedSchema = z
  .object({
    type: z.literal("join-applied"),
    ...envelope,
    branches: z.array(z.string()),
    published_keys: z.array(z.string()),
    winner: z.string().optional(),
  })
  .strict();

// A run cancelled best-effort (§5.6, §8.1): `run_id`/`node_id` identify it; `cause_run_id` is the
// failing sibling run, non-null exactly for `sibling-failed`. `cause` defaults to `sibling-failed`
// because every persisted line is re-validated on read, so a required field would break old logs.
const RunCancelledSchema = z
  .object({
    type: z.literal("run-cancelled"),
    ...envelope,
    cause: z.enum(["sibling-failed", "sibling-succeeded", "operator"]).default("sibling-failed"),
    cause_run_id: z.string().nullable(),
  })
  .strict();

// While-do loops (§5.2–5.4): `iteration-started` fires before each body with a 1-based `iteration` and
// the passing trace; `loop-exited` fires once with the exit `reason`, `iterations` count and final trace.
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

// Goto passes and jumps (docs/spec/goto.md §7, ADR 0054/0061): `pass-started` opens a pass (pass 1
// included, its envelope naming the opening goto, both ids null); `goto-taken` records a jump's 1-based
// count, resolved bound and pass; `goto-exhausted` records a goto reached with its jumps spent.
const PassStartedSchema = z
  .object({ type: z.literal("pass-started"), ...envelope, pass: z.number().int().positive() })
  .strict();
const GotoTakenSchema = z
  .object({
    type: z.literal("goto-taken"),
    ...envelope,
    target_node_id: z.string(),
    target_node_name: z.string(),
    jump: z.number().int().positive(),
    max_jumps: z.number().int().positive(),
    pass: z.number().int().positive(),
  })
  .strict();
const GotoExhaustedSchema = z
  .object({
    type: z.literal("goto-exhausted"),
    ...envelope,
    target_node_id: z.string(),
    target_node_name: z.string(),
    max_jumps: z.number().int().positive(),
    pass: z.number().int().positive(),
  })
  .strict();

// A resumed tree reused one node's recorded work instead of re-running it (resume-restore-semantics.md
// §6): no step events fire, so this marker is the log's only record of the reuse. Fires once per reuse
// decision; `original_run_id` back-references the run in the *original* tree that holds the real data.
const ReuseMarkerSchema = z
  .object({ type: z.literal("reuse-marker"), ...envelope, original_run_id: z.string() })
  .strict();

// A leaf step entered `awaiting`: the worker returned `{ status: "awaiting" }` and the engine suspended
// it until an external `complete` call — still live, so distinct from `step-finished`. `assignee` names
// who the offline activity is for, `.default(null)` so pre-field persisted lines keep parsing on read.
const StepAwaitingSchema = z
  .object({
    type: z.literal("step-awaiting"),
    ...envelope,
    assignee: z.string().nullable().default(null),
  })
  .strict();

export const LogEventSchema = z.discriminatedUnion("type", [
  StepStartedSchema,
  StepFinishedSchema,
  StepAwaitingSchema,
  CheckpointPassedSchema,
  CheckpointFailedSchema,
  BranchTakenSchema,
  BranchNoMatchSchema,
  JoinAppliedSchema,
  RunCancelledSchema,
  IterationStartedSchema,
  LoopExitedSchema,
  PassStartedSchema,
  GotoTakenSchema,
  GotoExhaustedSchema,
  ReuseMarkerSchema,
]);

export type LogEvent = z.infer<typeof LogEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedSchema>;
export type StepFinishedEvent = z.infer<typeof StepFinishedSchema>;
export type JoinAppliedEvent = z.infer<typeof JoinAppliedSchema>;
export type RunCancelledEvent = z.infer<typeof RunCancelledSchema>;
export type StepAwaitingEvent = z.infer<typeof StepAwaitingSchema>;
export type ReuseMarkerEvent = z.infer<typeof ReuseMarkerSchema>;
