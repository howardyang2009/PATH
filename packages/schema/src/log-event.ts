import { z } from "zod";
import { TerminalRunStatusSchema } from "./run-status.js";
import { TraceSchema } from "./trace.js";

/**
 * The typed log-event stream (mvp spec §8.1). Every event shares an envelope — `seq` (monotonic
 * per **root run**, the ordering truth since timestamps collide under parallelism), `ts`, `type`
 * (this flat discriminated union), `run_id`, `node_id` (the GUID) and `node_name` (the human label,
 * ADR 0007) — plus a per-type payload.
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
 * `node_id`/`node_name` are nullable together: the top-level workflow is wrapped in an implicit root
 * step (invariant 2) that has no node of its own — its lifecycle events carry both null.
 */
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
    // The *name* of the worker the step ran on (ADR 0021 sub-14). A leaf step carries its resolved
    // worker name (`spawn`/`sdk`); a workflow-run's implicit-root-step event carries `"workflow"`,
    // the step type itself — a workflow step runs a nested run, not a worker.
    worker_name: z.string(),
  })
  .strict();

const StepFinishedSchema = z
  .object({
    type: z.literal("step-finished"),
    ...envelope,
    status: TerminalRunStatusSchema,
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
// the enclosing workflow-step's run id + the `parallel` node's id/name (envelope), plus the branch
// names in apply order and the context keys those branches published (names, not GUIDs — ADR 0007).
// `winner` is the winning branch name, present only for a `wait-one` join (wait-one-join.md §8); a
// `collect` join lands every branch and has no single winner, so it omits the field.
const JoinAppliedSchema = z
  .object({
    type: z.literal("join-applied"),
    ...envelope,
    branches: z.array(z.string()),
    published_keys: z.array(z.string()),
    winner: z.string().optional(),
  })
  .strict();

// A run cancelled best-effort (mvp spec §5.6, §8.1): `run_id`/`node_id` identify the cancelled run
// and its node. `cause` says why — `sibling-failed` (a `collect` branch failed), `sibling-succeeded`
// (a `wait-one` branch won the race, so the still-running losers are cancelled — wait-one-join.md §5),
// or `operator` (a cancel request against the root run, #52). `cause_run_id` is the failing sibling
// run, non-null exactly for `sibling-failed`; it is null for `sibling-succeeded` and `operator`.
//
// `cause` defaults to `sibling-failed`, the only cause that existed before #52: every persisted log
// line is re-validated on read (readNdjsonLog, getLogEventsForRoot), and that path feeds SSE replay,
// so a *required* field here would make every already-written `run.log` throw when an operator opens
// an old run. Old lines keep parsing, and read back as sibling-failed with their `cause_run_id`.
const RunCancelledSchema = z
  .object({
    type: z.literal("run-cancelled"),
    ...envelope,
    cause: z.enum(["sibling-failed", "sibling-succeeded", "operator"]).default("sibling-failed"),
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

// A resumed tree reused one node's recorded work instead of re-running it (#172,
// resume-restore-semantics.md §6): no `step-started`/`step-finished` fires for the node, so this
// marker is the only place the resumed tree's own log records it happened — §8.1's "complete
// narrative" would otherwise have a silent gap exactly where the reused subtree is. Fires **once
// per reuse decision** (a reused workflow-run collapses its whole subtree into this one event, not
// one per descendant). The envelope's `run_id` is the nearest re-entered workflow-run ancestor in
// the successor tree, `node_id` the reused node's own id; `original_run_id` back-references the run
// in the *original* tree that holds the real data, so a reader follows the pointer instead of a gap.
const ReuseMarkerSchema = z.object({ type: z.literal("reuse-marker"), ...envelope, original_run_id: z.string() }).strict();

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
  ReuseMarkerSchema,
]);

export type LogEvent = z.infer<typeof LogEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedSchema>;
export type StepFinishedEvent = z.infer<typeof StepFinishedSchema>;
export type JoinAppliedEvent = z.infer<typeof JoinAppliedSchema>;
export type RunCancelledEvent = z.infer<typeof RunCancelledSchema>;
export type ReuseMarkerEvent = z.infer<typeof ReuseMarkerSchema>;
