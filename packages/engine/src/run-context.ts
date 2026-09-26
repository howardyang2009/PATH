import type { ConfigObject, JsonValue, RunRecord, WorkflowFile } from "@path/schema";
import type { LoadedStepPluginRegistry } from "./plugin/scan.js";
import type { ProcessorSemaphore } from "./processor-semaphore.js";
import type { EnvSource } from "./resolve-env.js";
import type { RunResume } from "./resume-plan.js";
import type { Emitter } from "./run-emitter.js";
import type { Observation } from "./run-observer.js";

/**
 * The engine's single emit choke point: secrets are masked here (mvp spec §8.3), so no caller can forget to, and a
 * run with no observer emits into a no-op.
 */
export type Emit = (o: Observation) => Promise<void>;

/**
 * The step-execution resources one run tree shares: the frozen scanned plugin registry with `workerOverrides` merged
 * (ADR 0021 sub-8) and the semaphore capping live processor-slot workers (mvp spec §5.5).
 */
export interface StepRuntime {
  registry: LoadedStepPluginRegistry;
  semaphore: ProcessorSemaphore;
  /**
   * The launch worker-default table (ADR 0044), `{ <stepType>: <workerName> }` supplied once at launch. Run-wide, so
   * a nested run that swaps `file` keeps it; above file-scoped `worker_defaults`, below an explicit `node.worker`
   * pin.
   */
  launchWorkerDefaults?: { [stepType: string]: string };
}

// The result of running a node or sequence: `cancelled` carries no error, a failure carries its `error` and the
// `causeRunId` its sibling cancellations narrate (mvp spec §5.6). `awaiting` is the person-activity park (ADR
// 0039/0041) — the engine tore down and a Complete replay reopens the tree.
export type SeqOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error: string; causeRunId?: string }
  | { status: "cancelled" }
  | { status: "awaiting" }
  // A goto jump (ADR 0053, goto.md §3.2): `goto`/`target` are node GUIDs, `output` the unchanged incoming output;
  // only the top-level walk consumes it.
  | { status: "goto"; goto: string; target: string; output: JsonValue };

export type CancelCause = "operator" | "sibling-failed" | "sibling-succeeded";

/**
 * Shared cancellation of a run tree or one `parallel` block: a branch failing or winning aborts in-flight siblings
 * best-effort; `cause`/`causeRunId` record which and stay null until one fires.
 */
export interface Cancellation {
  signal: AbortSignal;
  causeRunId: string | null;
  cause: CancelCause | null;
  trigger(causeRunId: string): void;
  triggerWin(): void;
}

export type NodeWalk = (
  run: RunContext,
  nodes: WorkflowFile["body"],
  seedInput: JsonValue,
  exec: NodeExecContext,
) => Promise<SeqOutcome>;

// What each node in a sequence reads and writes: the `context` it sees (inside a `parallel` block a per-branch
// snapshot copy, so siblings never observe each other's writes — mvp spec §5.3), the enclosing cancellation,
// `onPublish`, and the run's `walk`.
export interface NodeExecContext {
  context: { [key: string]: JsonValue };
  signal?: AbortSignal;
  cancellation?: Cancellation;
  onPublish: (updates: { [key: string]: JsonValue }) => Promise<void>;
  walk: NodeWalk;
}

export interface RunIdentity {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  nodeName: string | null;
  /**
   * A `while-do` iteration container's 1-based ordinal (ADR 0037); absent on every other run. It carries the
   * container's `nodeId`/`nodeName` plus the ordinal so the tree can tell one loop pass from the next.
   */
  iteration?: number;
  pass?: number;
}

/**
 * Everything fixed for the life of one workflow-run. The mutable half — the context a sequence writes, its
 * cancellation, how a publish lands — is `NodeExecContext` and varies per sequence.
 */
export interface RunContext {
  file: WorkflowFile;
  fileDir: string;
  /** This file's declared config with the incoming config shadowing it, nearest wins (format §7). */
  fileConfig: ConfigObject;
  identity: RunIdentity;
  /**
   * This run's producer of observations: every tier goes through it, so no walker respells the envelope or touches
   * the raw masking sink.
   */
  emitter: Emitter;
  env: EnvSource;
  files?: Map<string, WorkflowFile>;
  /** Shared by the whole run tree, so the registry and processor cap span nested runs too (mvp spec §5.5). */
  runtime: StepRuntime;
  resume?: RunResume;
  /**
   * Complete-continue state (ADR 0041), present only during a Complete replay. Unlike Resume, it re-drives **this
   * same tree** in place: re-entered runs keep their ids and already-`succeeded` nodes are reused read-only from
   * their own rows.
   */
  continue?: ContinueState;
  /**
   * Detached `do-not-wait` branch runs launched under this workflow-run; the owning run drains them at its exit
   * barrier so the tree stays strictly nested and no live work is left behind. A branch failure is isolated, so a
   * promise never rejects except on an audit fault.
   */
  detached: Promise<void>[];
}

/**
 * The Complete-continue state threaded through a replay over the appendable tree (ADR 0041). `existingRuns` is every
 * row read once, reuse rows pre-swapped for their source; `target` names the parked leaf to complete — the walk
 * transitions it `awaiting → succeeded` and parks again at any other `awaiting` leaf (park-at-join).
 */
export interface ContinueState {
  existingRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  target: { stepRunId: string; output: JsonValue };
}

/** One workflow-run's resume state — owned by the Resume plan module (`resume-plan.ts`). */
export type { RunResume } from "./resume-plan.js";
