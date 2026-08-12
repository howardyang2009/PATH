import { randomUUID } from "node:crypto";
import type { JsonValue, Worker } from "@path/schema";
import type { Trace } from "./condition.js";
import type { Emit, RunIdentity } from "./run-context.js";
import type { Observation, RunOutcome } from "./run-observer.js";

/**
 * The run-scoped producer of **observations** (CONTEXT, Audit — "Emitter"). One is built per
 * workflow-run from that run's `identity`, and it owns the shared envelope so a call site declares
 * only what a given observation *adds*, never the fields every observation already carries.
 *
 * **What it absorbs, and why.** Before this seam, all ~28 emit sites hand-built the full
 * `Observation` literal and re-threaded the envelope — `run_id`/`root_run_id` on every one, plus
 * `node_id`/`node_name` copied off the node for control-node observations, plus the root-only
 * `run-started` extras behind `...(isRoot ? {…} : {})` spreads. So every identity-shape change (the
 * GUID `id` of ADR 0006, the `node_name` audit field of ADR 0007) had to land in all of them at
 * once. Here it lands in one module: the envelope is computed from `identity`, and `runStarted`
 * gates the root-only trio on `isRoot` itself.
 *
 * **Two tiers, one for each subject of an observation.** The run tier's observations are attributed
 * to the workflow-run (`identity.runId`) — its own lifecycle (`run-started`/`run-finished`/
 * `context-changed`) and the engine-evaluated control nodes it walks (a checkpoint, a branch, a
 * loop, a join, a reuse decision), whose `node_id`/`node_name` come off the node. A leaf step is a
 * *different* subject: it mints its own run id and four observations share it. That is the
 * **step-scoped** sub-emitter (`step`), so the minted id can't be dropped between `step-started` and
 * `step-finished`.
 *
 * **It sits above the mask point, not through it.** The emitter composes the record and calls
 * `emit`; `emit` is where masking happens (mvp spec §8.3, `runWorkflow`'s single choke point). The
 * `Observation` union stays the wire type crossing that seam — this only concentrates who *builds* a
 * member of it.
 */

/** The identity a control-node or step observation names its node by — the node's own `id`/`name`. */
export interface NodeRef {
  id: string;
  name: string;
}

/** A `step-finished` a step reaches on its own (not by cancellation): succeeded with output, or failed. */
type StepFinish = Exclude<RunOutcome, { status: "cancelled" }>;

/**
 * A single leaf step run's observations, all under one minted run id (`runId`, exposed because a
 * failing step names itself as a sibling cancellation's `causeRunId`). Lifecycle: `started`, then any
 * of `usage`/`stderr`, then exactly one terminal — `finished` when the step ran to a verdict of its
 * own, or `cancelled` when the engine killed it (which narrates `run-cancelled` *then* the terminal
 * `step-finished`, mvp spec §5.6).
 */
export interface StepEmitter {
  /** This step run's own minted id — the `causeRunId` its failure hands its cancelling siblings. */
  readonly runId: string;
  started(args: { stepType: string; worker: Worker; input: JsonValue }): Promise<void>;
  usage(args: { usage: JsonValue | null; estimatedCostUsd: number | null }): Promise<void>;
  stderr(stderr: string): Promise<void>;
  finished(outcome: StepFinish): Promise<void>;
  /** The kill pair (§5.6): `run-cancelled` carrying the cause, then a `cancelled` `step-finished`. */
  cancelled(args: { cause: "sibling-failed" | "sibling-succeeded" | "operator"; causeRunId: string | null }): Promise<void>;
}

/**
 * The run-tier surface: this workflow-run's own lifecycle and the control nodes it evaluates. One
 * method per observation type (the envelope is what carries the depth, not a discriminated payload
 * that would re-leak the shape to the call site). `step` opens a step-scoped sub-emitter.
 */
export interface Emitter {
  /**
   * This workflow-run begins. `input`/`worker` are the run's own; the rest are root-only and gated
   * here: the source-workflow trio (`workflowId`/`workflowName`/`workflowPath`, ADR 0006) rides only
   * a root run's `run-started`, and `resumedFromRootRunId` (ADR 0009 lineage) only when the run is a
   * successor. A nested run passes them and they are dropped — `isRoot` is read off `identity`.
   */
  runStarted(args: {
    input: JsonValue;
    worker: Worker;
    resumedFromRootRunId?: string;
    workflowId?: string;
    workflowName?: string;
    workflowPath?: string;
  }): Promise<void>;
  /** This workflow-run finished — succeeded (with output), failed (with error), or cancelled. */
  runFinished(outcome: RunOutcome): Promise<void>;
  /** A publish landed and this run's context changed (persistence-only, never narrated). */
  contextChanged(context: JsonValue): Promise<void>;
  checkpointEvaluated(node: NodeRef, args: { passed: boolean; trace: Trace }): Promise<void>;
  branchTaken(node: NodeRef, args: { arm: number | "else"; trace: Trace | null }): Promise<void>;
  branchNoMatch(node: NodeRef, args: { traces: Trace[] }): Promise<void>;
  iterationStarted(node: NodeRef, args: { iteration: number; trace: Trace }): Promise<void>;
  loopExited(
    node: NodeRef,
    args: { reason: "condition-false" | "max-iterations-exceeded"; iterations: number; trace: Trace },
  ): Promise<void>;
  joinApplied(
    node: NodeRef,
    args: { branches: string[]; publishedKeys: string[]; winner?: string },
  ): Promise<void>;
  reuseMarker(node: NodeRef, args: { originalRunId: string }): Promise<void>;
  /** Open a step-scoped sub-emitter for one leaf step run, minting its run id. */
  step(node: NodeRef): StepEmitter;
}

/**
 * Build the emitter for one workflow-run over the run tree's masking `emit` (the choke point every
 * observation still passes through). `identity` fixes the envelope for this run's whole life.
 */
export function createEmitter(identity: RunIdentity, emit: Emit): Emitter {
  const { runId, rootRunId, parentRunId, nodeId, nodeName } = identity;
  const isRoot = parentRunId === null;

  return {
    runStarted(args): Promise<void> {
      return emit({
        type: "run-started",
        runId,
        rootRunId,
        parentRunId,
        nodeId,
        nodeName,
        input: args.input,
        worker: args.worker,
        // Successor lineage rides presence, not root-ness — the caller sets it on the root alone.
        ...(args.resumedFromRootRunId !== undefined ? { resumedFromRootRunId: args.resumedFromRootRunId } : {}),
        // Source-workflow identity is root-only (ADR 0006): a nested run's producing node is already
        // named by `nodeId`/`nodeName`, so the trio is dropped for it even when supplied.
        ...(isRoot && args.workflowId !== undefined ? { workflowId: args.workflowId } : {}),
        ...(isRoot && args.workflowName !== undefined ? { workflowName: args.workflowName } : {}),
        ...(isRoot && args.workflowPath !== undefined ? { workflowPath: args.workflowPath } : {}),
      });
    },
    runFinished(outcome): Promise<void> {
      return emit({ type: "run-finished", runId, rootRunId, ...outcome });
    },
    contextChanged(context): Promise<void> {
      return emit({ type: "context-changed", runId, rootRunId, context });
    },
    checkpointEvaluated(node, args): Promise<void> {
      return emit({
        type: "checkpoint-evaluated",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        passed: args.passed,
        trace: args.trace,
      });
    },
    branchTaken(node, args): Promise<void> {
      return emit({
        type: "branch-taken",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        arm: args.arm,
        trace: args.trace,
      });
    },
    branchNoMatch(node, args): Promise<void> {
      return emit({
        type: "branch-no-match",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        traces: args.traces,
      });
    },
    iterationStarted(node, args): Promise<void> {
      return emit({
        type: "iteration-started",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        iteration: args.iteration,
        trace: args.trace,
      });
    },
    loopExited(node, args): Promise<void> {
      return emit({
        type: "loop-exited",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        reason: args.reason,
        iterations: args.iterations,
        trace: args.trace,
      });
    },
    joinApplied(node, args): Promise<void> {
      return emit({
        type: "join-applied",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        branches: args.branches,
        publishedKeys: args.publishedKeys,
        ...(args.winner !== undefined ? { winner: args.winner } : {}),
      });
    },
    reuseMarker(node, args): Promise<void> {
      return emit({
        type: "reuse-marker",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        originalRunId: args.originalRunId,
      });
    },
    step(node): StepEmitter {
      // The step run's own id, minted once and shared across its four observations — the reason the
      // step tier is a handle and not four run-emitter methods each re-passed the same id.
      const stepRunId = randomUUID();
      return {
        runId: stepRunId,
        started(args): Promise<void> {
          return emit({
            type: "step-started",
            runId: stepRunId,
            rootRunId,
            parentRunId: runId, // the enclosing workflow-run is this step's parent
            nodeId: node.id,
            nodeName: node.name,
            stepType: args.stepType,
            worker: args.worker,
            input: args.input,
          });
        },
        usage(args): Promise<void> {
          return emit({
            type: "step-usage",
            runId: stepRunId,
            rootRunId,
            usage: args.usage,
            estimatedCostUsd: args.estimatedCostUsd,
          });
        },
        stderr(stderr): Promise<void> {
          return emit({ type: "step-stderr", runId: stepRunId, rootRunId, stderr });
        },
        finished(outcome): Promise<void> {
          return emit({ type: "step-finished", runId: stepRunId, rootRunId, ...outcome });
        },
        async cancelled(args): Promise<void> {
          await emit({
            type: "run-cancelled",
            runId: stepRunId,
            rootRunId,
            nodeId: node.id,
            nodeName: node.name,
            cause: args.cause,
            causeRunId: args.causeRunId,
          });
          await emit({ type: "step-finished", runId: stepRunId, rootRunId, status: "cancelled" });
        },
      };
    },
  };
}
