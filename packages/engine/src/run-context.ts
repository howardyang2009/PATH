import {
  type ConfigObject,
  type JsonValue,
  type RunRecord,
  type WorkflowFile,
  walkNodes,
} from "@path/schema";
import type { Continuation } from "./continuation.js";
import type { LoadedStepPluginRegistry } from "./plugin-seam/scan.js";
import type { ProcessorSemaphore } from "./processor-semaphore.js";
import type { EnvSource } from "./resolve-env.js";
import type { Emitter } from "./run-emitter.js";
import type { RunEvent } from "./run-observer.js";

/**
 * The engine's single emit choke point: secrets are masked here (mvp spec §8.3), so no caller can
 * forget to, and a run with no observer emits into a no-op.
 */
export type Emit = (e: RunEvent) => Promise<void>;

/**
 * The step-execution resources one run tree shares: the frozen scanned plugin registry with
 * `workerOverrides` merged (ADR 0021 sub-8) and the semaphore capping live processor-slot workers
 * (mvp spec §5.5).
 */
export interface StepRuntime {
  registry: LoadedStepPluginRegistry;
  semaphore: ProcessorSemaphore;
  /**
   * The launch worker-default table (ADR 0044), `{ <stepType>: <workerName> }` supplied once at
   * launch. Run-wide, so a nested run that swaps `file` keeps it; above file-scoped
   * `worker_defaults`, below an explicit `node.worker` pin.
   */
  launchWorkerDefaults?: { [stepType: string]: string };
}

// The result of running a node or sequence: `cancelled` carries no error, a failure carries its
// `error` and the `causeRunId` its sibling cancellations narrate (mvp spec §5.6). `awaiting` is the
// person-activity park (ADR 0039/0041) — the engine tore down and a Complete replay reopens the
// tree.
export type SeqOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error: string; causeRunId?: string }
  | { status: "cancelled" }
  | { status: "awaiting" }
  // A goto jump (ADR 0053, goto.md §3.2): `goto`/`target` are node GUIDs, `output` the unchanged
  // incoming output; only the top-level walk consumes it.
  | { status: "goto"; goto: string; target: string; output: JsonValue };

/**
 * What a container body's walk returns. A `goto` may not sit under a `while-do` or a `parallel`
 * (ADR 0058), so {@link walkContainerBody} strips the jump variant and a container runner cannot
 * mishandle one.
 */
export type BodyOutcome = Exclude<SeqOutcome, { status: "goto" }>;

export type CancelCause = "operator" | "sibling-failed" | "sibling-succeeded";

/**
 * Shared cancellation of a run tree or one `parallel` block: a branch failing or winning aborts
 * in-flight siblings best-effort; `cause`/`causeRunId` record which and stay null until one fires.
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

// What each node in a sequence reads and writes: the `context` it sees (inside a `parallel` block a
// per-branch snapshot copy, so siblings never observe each other's writes — mvp spec §5.3), the
// enclosing cancellation, `onPublish`, and the run's `walk`.
export interface NodeExecContext {
  context: { [key: string]: JsonValue };
  signal?: AbortSignal;
  cancellation?: Cancellation;
  onPublish: (updates: { [key: string]: JsonValue }) => Promise<void>;
  /** The run's own walk, injected so a control runner never imports the one that dispatches it. */
  walk: NodeWalk;
}

/**
 * A container body's walk (`while-do` iteration, `parallel` branch): load refuses a `goto` under
 * either (ADR 0058), so a jump that reaches here is a skipped load. It fails the run, naming the
 * node, rather than escaping into a container that has nowhere to land it — the only way in, so a
 * container runner never holds a value its own outcome type cannot express.
 */
export async function walkContainerBody(
  run: RunContext,
  nodes: WorkflowFile["body"],
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<BodyOutcome> {
  const outcome = await exec.walk(run, nodes, seedInput, exec);
  if (outcome.status !== "goto") return outcome;
  // The jump may sit under a `sequence` or a `branch`, so name it by its own id.
  const jumped = [...walkNodes(nodes)].find((node) => node.id === outcome.goto);
  return {
    status: "failed",
    error: `goto "${jumped?.name ?? outcome.goto}": a jump may not leave a while-do or parallel body`,
  };
}

export interface RunIdentity {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  nodeName: string | null;
  /**
   * A `while-do` iteration container's 1-based ordinal (ADR 0037); absent on every other run. It
   * carries the container's `nodeId`/`nodeName` plus the ordinal so the tree can tell one loop pass
   * from the next.
   */
  iteration?: number;
  pass?: number;
}

/**
 * Everything fixed for the life of one workflow-run. The mutable half — the context a sequence
 * writes, its cancellation, how a publish lands — is `NodeExecContext` and varies per sequence.
 */
export interface RunContext {
  file: WorkflowFile;
  fileDir: string;
  /** This file's declared config with the incoming config shadowing it, nearest wins (format
   * §7). */
  fileConfig: ConfigObject;
  identity: RunIdentity;
  /**
   * This run's producer of run events: every tier goes through it, so no walker respells the
   * envelope or touches the raw masking sink.
   */
  emitter: Emitter;
  env: EnvSource;
  files?: Map<string, WorkflowFile>;
  /** Shared by the whole run tree, so the registry and processor cap span nested runs too (mvp spec
   * §5.5). */
  runtime: StepRuntime;
  /**
   * This run's view of what is already recorded under it — the one thing every walker reads to
   * decide reuse, re-entry and pass pairing (Resume ADR 0036, Complete ADR 0041).
   */
  continuation: Continuation;
  /**
   * Detached `do-not-wait` branch runs launched under this workflow-run; the owning run drains them
   * at its exit barrier so the tree stays strictly nested and no live work is left behind. A branch
   * failure is isolated, so a promise never rejects except on an audit fault.
   */
  detached: Promise<void>[];
}

/** What identifies a child run beside its parent: the node that owns it, and its ordinal if it is a
 * container. */
export interface ChildRunKey {
  /** The owning node, or `null` for goto pass 1. */
  owner: { id: string; name: string } | null;
  iteration?: number;
  pass?: number;
}

/**
 * The Complete-continue state threaded through a replay over the appendable tree (ADR 0041).
 * `existingRuns` is every row read once, reuse rows pre-swapped for their source; `target` names
 * the parked leaf to complete — the walk transitions it `awaiting → succeeded` and parks again at
 * any other `awaiting` leaf (park-at-join).
 */
export interface ContinueState {
  existingRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  target: { stepRunId: string; output: JsonValue };
}
