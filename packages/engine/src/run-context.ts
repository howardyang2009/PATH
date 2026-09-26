import type { ConfigObject, JsonValue, RunRecord, WorkflowFile } from "@path/schema";
import type { LoadedStepPluginRegistry } from "./plugin/scan.js";
import type { ProcessorSemaphore } from "./processor-semaphore.js";
import type { EnvSource } from "./resolve-env.js";
import type { RunResume } from "./resume-plan.js";
import type { Emitter } from "./run-emitter.js";
import type { Observation } from "./run-observer.js";

/**
 * The vocabulary one run tree threads through its walk, shared by the executor (`run-workflow.ts`)
 * and the parallel block (`run-parallel.ts`). These types have no behaviour of their own — they are
 * the shape every node runner reads and writes — so they live apart from either module that acts on
 * them, and neither has to import the other to name them.
 *
 * `RunResume` is imported from `resume-plan.ts` as a type only; the edge erases at compile time, so it
 * is not a runtime cycle.
 */

/**
 * The engine's single emit choke point, threaded to every node of the run tree in place of the
 * observer itself (#62). Two things are guaranteed here and therefore nowhere else:
 *
 * - **Secrets are masked** (mvp spec §8.3) before anything crosses the seam. No caller has to apply
 *   a wrapper, so no caller can forget to — and no wrapper can cover part of the union.
 * - **The absent observer is handled once.** A run with nothing observing it emits into a no-op, so
 *   the emitter built over it (`run-emitter.ts`) never has to check for one.
 */
export type Emit = (o: Observation) => Promise<void>;

/**
 * The step-execution resources one run tree shares: the frozen plugin registry every leaf step
 * dispatches through — `registry[type].workers[worker]` (ADR 0021 sub-8) — and the single semaphore
 * that caps how many processor-slot workers are live at once (mvp spec §5.5). The registry is the
 * scanned one with `options.workerOverrides` already merged over it (`runWorkflow`).
 */
export interface StepRuntime {
  registry: LoadedStepPluginRegistry;
  semaphore: ProcessorSemaphore;
  /**
   * The **launch** worker-default table (ADR 0044): a `{ <stepType>: <workerName> }` map the operator
   * supplies once at launch, picking the worker for a type's un-pinned steps for the whole run. It
   * lives on the run tree's shared runtime — not on `file` — precisely because it is **run-wide**: it
   * reaches every un-pinned step of every file in the tree, child `workflow`-ref files included, so a
   * nested run (which swaps `file` but keeps `runtime`) reads the same table. In dispatch it sits above
   * the file-scoped `file.worker_defaults` and below an explicit `node.worker` pin. Absent when the
   * operator supplied none. Registry-relative validity is a launch-boundary concern (#506), not this
   * runtime's.
   */
  launchWorkerDefaults?: { [stepType: string]: string };
}

// The result of running one node (or a whole node sequence). A step run that a failing sibling
// cancelled reports `cancelled`; a genuine failure carries its `error` and, when a killed step run
// is the trigger, the `causeRunId` the sibling cancellations narrate (mvp spec §5.6).
//
// `awaiting` is the person-activity park (ADR 0039/0041): a leaf returned `{ status: "awaiting" }`
// and the engine tore down rather than holding a process. It propagates up like a non-success
// (fail-fast stops the walk) but is neither a failure nor a cancel — the enclosing runs stay
// `running` (no terminal `run-finished`), and the tree is reopened later by a Complete replay. It
// carries no payload: the parked leaf's `awaiting` row already lives in the store, and the Complete
// entry point locates the leaf by its own step-run id, not by this outcome.
export type SeqOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error: string; causeRunId?: string }
  | { status: "cancelled" }
  | { status: "awaiting" }
  // A goto jump (ADR 0053, spec docs/spec/goto.md §3.2): `goto` is the goto node's GUID, `target` the
  // target first-level node's GUID, `output` the goto's incoming output, unchanged. Every nested walker
  // hands it up like any non-`succeeded` outcome; only the file's top-level walk consumes it.
  | { status: "goto"; goto: string; target: string; output: JsonValue };

/**
 * The three causes a cancellation can have (CONTEXT.md § Cancellation). `operator` is a cancel request
 * against the root run; the two sibling causes are the engine stopping in-flight work because a
 * `parallel` block resolved — `sibling-failed` for a `collect` branch that failed, `sibling-succeeded`
 * for a `wait-one` winner that cancelled the losers (mvp spec §5.6).
 */
export type CancelCause = "operator" | "sibling-failed" | "sibling-succeeded";

// The shared cancellation of a run tree or one `parallel` block: its work runs under `signal`, and
// either a branch failing (`collect`) or a branch winning the race (`wait-one`) aborts the in-flight
// siblings best-effort. `cause` records which, and is null until one fires (an outside abort, an
// operator cancelling the root run, leaves it null). For `sibling-failed` the failing step run's id
// becomes `causeRunId`, which the losers' run-cancelled events point back at; a win has no cause run,
// so `causeRunId` stays null there too. `cancellation.ts` owns the two constructors — the root run's
// and a block's — so no walker assembles the cause chain itself.
export interface Cancellation {
  signal: AbortSignal;
  causeRunId: string | null;
  cause: CancelCause | null;
  /** A `collect` branch failed: cancel in-flight siblings, `causeRunId` naming the failing run. */
  trigger(causeRunId: string): void;
  /** A `wait-one` branch won the race: cancel the still-running losers (no cause run). */
  triggerWin(): void;
}

/**
 * How a construct runs a nested sequence of nodes: the run's own **walk**, handed to it rather than
 * imported. The walk owns order, the default-input chain and the between-node abort check; a
 * construct owns only *which* body it hands in — a `parallel` branch, a reused `wait-one` winner, a
 * `branch` arm, a loop body. Threading it here is also what removed the
 * `run-parallel.ts → run-workflow.ts → runNode → runParallelNode` function cycle: the parallel block
 * used to import `runSequence` back from the executor that dispatches it.
 */
export type NodeWalk = (
  run: RunContext,
  nodes: WorkflowFile["body"],
  seedInput: JsonValue,
  exec: NodeExecContext,
) => Promise<SeqOutcome>;

// What each node in a sequence reads and writes: the `context` it sees (the run's own for the
// top-level body; a per-branch snapshot copy inside a `parallel` block, so siblings never observe
// each other's writes — mvp spec §5.3), the `signal`/`cancellation` of any enclosing parallel,
// `onPublish` — how a landed publish is surfaced (context write-through at the top level; buffered
// for the join inside a branch) — and the run's `walk`, so no construct reaches back into the
// executor for one.
export interface NodeExecContext {
  context: { [key: string]: JsonValue };
  signal?: AbortSignal;
  cancellation?: Cancellation;
  onPublish: (updates: { [key: string]: JsonValue }) => Promise<void>;
  walk: NodeWalk;
}

// One workflow-run's identity within the run tree (#22). The root run has `parentRunId: null`
// and `nodeId: null`; a nested workflow-step's run carries its parent run's id and the `workflow`
// node's id — workflow-as-step means the child run *is* that step's run (CONTEXT invariant 2).
export interface RunIdentity {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  /** The `workflow` node's GUID `id` for a nested run; null for the root (ADR 0007). */
  nodeId: string | null;
  /** The `workflow` node's human `name` for a nested run; null for the root (ADR 0007). */
  nodeName: string | null;
  /**
   * A `while-do` iteration container's 1-based ordinal (ADR 0037); omitted/undefined on every other
   * run. It carries the container's `nodeId`/`nodeName` (the `while-do` node's) plus this ordinal, so
   * the run tree can tell one loop pass from the next.
   */
  iteration?: number;
  /**
   * A goto pass container's 1-based ordinal (ADR 0054); omitted/undefined on every other run. It
   * carries the opening goto's `nodeId`/`nodeName` (null for pass 1) plus this ordinal.
   */
  pass?: number;
}

/**
 * Everything that is fixed for the life of one workflow-run, threaded to every node walker.
 *
 * The mutable half — the context a sequence writes to, its cancellation, how a publish lands — is
 * `NodeExecContext`, and varies per sequence (a `parallel` branch gets its own snapshot copy). This
 * is the other half: the file being run, its effective config, who this run is, and the shared
 * resources of the run tree.
 *
 * Splitting the two is what lets the walkers live at module scope (#76). They used to be nested in
 * a 392-line closure and were reached only through a full `runWorkflow`, so the branch, loop and
 * join semantics that carry the spec had no seam a test could aim at. Four overlapping context bags
 * became these two.
 */
export interface RunContext {
  file: WorkflowFile;
  /** The workflow file's own directory: binary `cwd` defaults and nested `ref`s resolve against it. */
  fileDir: string;
  /** This file's declared config with the incoming config shadowing it, nearest wins (format §8). */
  fileConfig: ConfigObject;
  identity: RunIdentity;
  /**
   * This run's producer of observations (run-emitter.ts): every tier — run, control node, leaf step,
   * and a nested workflow-run via `emitter.child` — goes through it, so no walker respells the
   * envelope and no walker touches the raw masking sink. The emitter is the run tree's only door to
   * the audit seam.
   */
  emitter: Emitter;
  /** The run tree's environment snapshot, for the `$env` in a step's own config (#116). */
  env: EnvSource;
  files?: Map<string, WorkflowFile>;
  /** Shared by the whole run tree, so the registry and processor cap span nested runs too (mvp spec §5.5). */
  runtime: StepRuntime;
  /** This workflow-run's resume state (#172), when the run is being resumed; absent for a fresh run. */
  resume?: RunResume;
  /**
   * Complete-continue state (ADR 0041), present only during a Complete replay over the appendable
   * tree. Unlike Resume — which mints a fresh successor tree — a Complete re-drives **this same tree**
   * in place: every re-entered run keeps its existing run id and every already-`succeeded` node is
   * reused read-only from its own rows (no reuse marker, no new row). Absent on launch and on Resume.
   */
  continue?: ContinueState;
  /**
   * Detached `do-not-wait` branch runs launched under this workflow-run (do-not-wait-join.md §2): a
   * `do-not-wait` block starts every branch and does *not* await it at the join, pushing its run here
   * instead. The owning run drains these at its exit barrier (`settleDetached`, §1.1/§2) so the tree
   * stays strictly nested and `path run` never leaves live work behind. Each promise resolves on the
   * branch reaching a terminal status; a branch failure is isolated (§5), so the promise never rejects
   * except on an audit (ObserverError) fault.
   */
  detached: Promise<void>[];
}

/**
 * The Complete-continue state threaded through a replay over the appendable tree (ADR 0041). One
 * instance serves the whole re-driven tree; each node walker reads it to decide, per node, whether an
 * existing run of **this** tree already answers it.
 *
 * - `existingRuns` is every run row of the tree being continued, read once. Reuse rows are pre-swapped
 *   for their source record (as `Project.resume` does), so a `succeeded` row here always addresses its
 *   own output blob directly.
 * - `readBlob` loads one blob (an existing run's `output.json`, a re-entered run's `context.json`) out
 *   of the store.
 * - `target` names the parked leaf being completed and the output to write. The walk reaches this leaf
 *   as the one `awaiting` run whose id matches, transitions it `awaiting → succeeded` with that output
 *   (the narrow read-only exception), and continues forward; every other `awaiting` leaf it meets is a
 *   still-parked sibling and parks the walk again (park-at-join).
 */
export interface ContinueState {
  existingRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  target: { stepRunId: string; output: JsonValue };
}

/** One workflow-run's resume state (#172) — owned by the Resume plan module (`resume-plan.ts`). */
export type { RunResume } from "./resume-plan.js";
