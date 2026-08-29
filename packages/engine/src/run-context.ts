import type { ConfigObject, JsonValue, RunRecord, WorkflowFile } from "@path/schema";
import type { LoadedStepPluginRegistry } from "./plugin/scan.js";
import type { ProcessorSemaphore } from "./processor-semaphore.js";
import type { Emitter } from "./run-emitter.js";
import type { ReusePlan } from "./plan-reuse.js";
import type { EnvSource } from "./resolve-env.js";
import type { Observation } from "./run-observer.js";
import type { ResumeInput } from "./run-workflow.js";

/**
 * The vocabulary one run tree threads through its walk, shared by the executor (`run-workflow.ts`)
 * and the parallel block (`run-parallel.ts`). These types have no behaviour of their own — they are
 * the shape every node runner reads and writes — so they live apart from either module that acts on
 * them, and neither has to import the other to name them.
 *
 * `ResumeInput` is imported back from `run-workflow.ts` as a type only (`RunResume.input`); the edge
 * erases at compile time, so it is not a runtime cycle.
 */

/**
 * The engine's single emit choke point, threaded to every node of the run tree in place of the
 * observer itself (#62). Two things are guaranteed here and therefore nowhere else:
 *
 * - **Secrets are masked** (mvp spec §8.3) before anything crosses the seam. No caller has to apply
 *   a wrapper, so no caller can forget to — and no wrapper can cover part of the union.
 * - **The absent observer is handled once.** A run with nothing observing it emits into a no-op, so
 *   the 24 call sites downstream are plain `await emit(...)` rather than optional chains.
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
}

// The result of running one node (or a whole node sequence). A step run that a failing sibling
// cancelled reports `cancelled`; a genuine failure carries its `error` and, when a killed step run
// is the trigger, the `causeRunId` the sibling cancellations narrate (mvp spec §5.6).
export type SeqOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error: string; causeRunId?: string }
  | { status: "cancelled" };

// The shared cancellation of one `parallel` block: its branches all run under `signal`, and either a
// branch failing (`collect`) or a branch winning the race (`wait-one`) aborts the in-flight siblings
// best-effort. `cause` records which — `sibling-failed` or `sibling-succeeded` (wait-one-join.md §5)
// — and is null until one fires (an outside abort, an operator cancelling the root run, leaves it
// null). For `sibling-failed` the failing step run's id becomes `causeRunId`, which the losers'
// run-cancelled events point back at; a win has no cause run, so `causeRunId` stays null there too.
export interface Cancellation {
  signal: AbortSignal;
  causeRunId: string | null;
  cause: "sibling-failed" | "sibling-succeeded" | null;
  /** A `collect` branch failed: cancel in-flight siblings, `causeRunId` naming the failing run. */
  trigger(causeRunId: string): void;
  /** A `wait-one` branch won the race: cancel the still-running losers (no cause run). */
  triggerWin(): void;
}

// What each node in a sequence reads and writes: the `context` it sees (the run's own for the
// top-level body; a per-branch snapshot copy inside a `parallel` block, so siblings never observe
// each other's writes — mvp spec §5.3), the `signal`/`cancellation` of any enclosing parallel, and
// `onPublish` — how a landed publish is surfaced (context write-through at the top level; buffered
// for the join inside a branch).
export interface NodeExecContext {
  context: { [key: string]: JsonValue };
  signal?: AbortSignal;
  cancellation?: Cancellation;
  onPublish: (updates: { [key: string]: JsonValue }) => Promise<void>;
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
 * One workflow-run's resume state (#172): the whole-tree read inputs, this run's own original
 * counterpart, and the reuse plan computed for *this* run's direct children. `runNode` consults
 * `plan` to decide whether a node reuses; `runWorkflowNode` uses `input`/`counterpart` to find a
 * non-reused nested workflow-run's own counterpart before recursing into it.
 */
export interface RunResume {
  input: ResumeInput;
  /** The original run this successor workflow-run corresponds to, or undefined for a fresh (added) run. */
  counterpart: RunRecord | undefined;
  /** Node ids of this run's direct children that reuse, each pointing at the original run it reuses. */
  plan: ReusePlan;
}
