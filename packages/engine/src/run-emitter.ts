import { randomUUID } from "node:crypto";
import {
  isRootRun,
  type JsonValue,
  type LaunchFacts,
  type RerunFromNodePathEntry,
} from "@path/schema";
import type { Trace } from "./condition.js";
import type { Emit, RunIdentity } from "./run-context.js";
import type { Observation, RunOutcome } from "./run-observer.js";

/**
 * The run-scoped producer of **observations**: one per workflow-run, owning the shared envelope so a call site
 * declares only what an observation adds. The run tier covers this run's lifecycle and control nodes, `step` is
 * the step-scoped sub-emitter, and every record carries its node identity. It composes; `emit` masks (§8.3).
 */

/** The identity a control-node or step observation names its node by — the node's own `id`/`name`. */
export interface NodeRef {
  id: string;
  name: string;
}

/** A `step-finished` a step reaches on its own (not by cancellation): succeeded with output, or failed. */
type StepFinish = Exclude<RunOutcome, { status: "cancelled" }>;

/**
 * A single leaf step run's observations, all under one minted run id. Lifecycle: `started`, then any of
 * `usage`/`stderr`, then exactly one terminal — `finished`, or `cancelled`, which narrates
 * `run-cancelled` *then* the terminal `step-finished` (mvp spec §5.6).
 */
export interface StepEmitter {
  /** This step run's own minted id — the `causeRunId` its failure hands its cancelling siblings. */
  readonly runId: string;
  started(args: { stepType: string; workerName: string; input: JsonValue }): Promise<void>;
  usage(args: { usage: JsonValue | null; estimatedCostUsd: number | null }): Promise<void>;
  stderr(stderr: string): Promise<void>;
  finished(outcome: StepFinish): Promise<void>;
  /**
   * This step's snapshot of the enclosing workflow-run's context, taken after the step finished and its publish
   * landed; emitted only for a succeeded step.
   */
  context(context: JsonValue): Promise<void>;
  /**
   * The step entered `awaiting` status: suspended until a `complete` resolves it. `assignee` is the worker's echoed
   * string, `null` when the node named none.
   */
  awaiting(args: { assignee: string | null }): Promise<void>;
  /** The kill pair (§5.6): `run-cancelled` carrying the cause, then a `cancelled` `step-finished`. */
  cancelled(args: {
    cause: "sibling-failed" | "sibling-succeeded" | "operator";
    causeRunId: string | null;
  }): Promise<void>;
}

/**
 * The run-tier surface: this workflow-run's own lifecycle and the control nodes it evaluates, one method per
 * observation type; `step` opens a step-scoped sub-emitter.
 */
export interface Emitter {
  /**
   * This workflow-run begins. The source-workflow trio, the launch facts and `resumedFromRootRunId` are
   * root-only, gated on `isRoot`; a nested run passes them and they are dropped.
   */
  runStarted(args: {
    input: JsonValue;
    resumedFromRootRunId?: string;
    rerunFromNodePath?: RerunFromNodePathEntry[];
    /**
     * The operator's frozen launch facts (ADR 0046): input override, config override, launch worker-default table
     * (ADR 0044). Root-only; persistence writes them to the root row only.
     */
    launchFacts?: LaunchFacts;
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
    args: {
      reason: "condition-false" | "max-iterations-exceeded";
      iterations: number;
      trace: Trace;
    },
  ): Promise<void>;
  joinApplied(
    node: NodeRef,
    args: { branches: string[]; publishedKeys: string[]; winner?: string },
  ): Promise<void>;
  /** A goto pass opened (ADR 0054): `opener` is the goto that opened it, `null` for pass 1. */
  passStarted(opener: NodeRef | null, args: { pass: number }): Promise<void>;
  gotoTaken(
    node: NodeRef,
    args: { target: NodeRef; jump: number; maxJumps: number; pass: number },
  ): Promise<void>;
  gotoExhausted(
    node: NodeRef,
    args: { target: NodeRef; maxJumps: number; pass: number },
  ): Promise<void>;
  reuseMarker(node: NodeRef, args: { originalRunId: string }): Promise<void>;
  /**
   * Open a step-scoped sub-emitter, minting a fresh run id. A Complete replay (ADR 0041) passes the
   * **existing** parked leaf's id, so its `step-finished` transitions that row in place.
   */
  step(node: NodeRef, existingRunId?: string): StepEmitter;
  /**
   * The emitter for a nested workflow-run, over this tree's same masking sink; its own `identity` fixes its envelope
   * and nothing of this run's leaks in.
   */
  child(identity: RunIdentity): Emitter;
}

/**
 * Build the emitter for one workflow-run over the tree's masking `emit`; `identity` fixes the envelope for its whole
 * life.
 */
export function createEmitter(identity: RunIdentity, emit: Emit): Emitter {
  const { runId, rootRunId, parentRunId, nodeId, nodeName, iteration, pass } = identity;
  const isRoot = isRootRun(identity);

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
        // A `while-do` iteration container's ordinal (ADR 0037): part of this run's identity, omitted on every other run.
        ...(iteration !== undefined ? { iteration } : {}),
        // A goto pass container's ordinal (ADR 0054), the same way.
        ...(pass !== undefined ? { pass } : {}),
        // Successor lineage rides presence, not root-ness — the caller sets it on the root alone.
        ...(args.resumedFromRootRunId !== undefined
          ? { resumedFromRootRunId: args.resumedFromRootRunId }
          : {}),
        // The rerun boundary (K) descent path is root-only (ADR 0032); the caller supplies it on the root alone.
        ...(isRoot && args.rerunFromNodePath !== undefined
          ? { rerunFromNodePath: args.rerunFromNodePath }
          : {}),
        // The frozen launch facts are root-only (ADR 0046); only the root row records them and only a resume/Complete
        // reads them back.
        ...(isRoot && args.launchFacts !== undefined ? { launchFacts: args.launchFacts } : {}),
        // Source-workflow identity is root-only (ADR 0006); a nested run's producing node is already named by
        // `nodeId`/`nodeName`.
        ...(isRoot && args.workflowId !== undefined ? { workflowId: args.workflowId } : {}),
        ...(isRoot && args.workflowName !== undefined ? { workflowName: args.workflowName } : {}),
        ...(isRoot && args.workflowPath !== undefined ? { workflowPath: args.workflowPath } : {}),
      });
    },
    runFinished(outcome): Promise<void> {
      return emit({ type: "run-finished", runId, rootRunId, nodeId, nodeName, ...outcome });
    },
    contextChanged(context): Promise<void> {
      return emit({ type: "context-changed", runId, rootRunId, nodeId, nodeName, context });
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
    passStarted(opener, args): Promise<void> {
      return emit({
        type: "pass-started",
        runId,
        rootRunId,
        nodeId: opener?.id ?? null,
        nodeName: opener?.name ?? null,
        pass: args.pass,
      });
    },
    gotoTaken(node, args): Promise<void> {
      return emit({
        type: "goto-taken",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        targetNodeId: args.target.id,
        targetNodeName: args.target.name,
        jump: args.jump,
        maxJumps: args.maxJumps,
        pass: args.pass,
      });
    },
    gotoExhausted(node, args): Promise<void> {
      return emit({
        type: "goto-exhausted",
        runId,
        rootRunId,
        nodeId: node.id,
        nodeName: node.name,
        targetNodeId: args.target.id,
        targetNodeName: args.target.name,
        maxJumps: args.maxJumps,
        pass: args.pass,
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
    step(node, existingRunId): StepEmitter {
      // The step run's own id, minted once and shared across its observations; a Complete replay reuses the parked
      // leaf's id so `step-finished` updates that row.
      const stepRunId = existingRunId ?? randomUUID();
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
            workerName: args.workerName,
            input: args.input,
          });
        },
        usage(args): Promise<void> {
          return emit({
            type: "step-usage",
            runId: stepRunId,
            rootRunId,
            nodeId: node.id,
            nodeName: node.name,
            usage: args.usage,
            estimatedCostUsd: args.estimatedCostUsd,
          });
        },
        stderr(stderr): Promise<void> {
          return emit({
            type: "step-stderr",
            runId: stepRunId,
            rootRunId,
            nodeId: node.id,
            nodeName: node.name,
            stderr,
          });
        },
        finished(outcome): Promise<void> {
          return emit({
            type: "step-finished",
            runId: stepRunId,
            rootRunId,
            nodeId: node.id,
            nodeName: node.name,
            ...outcome,
          });
        },
        awaiting(args): Promise<void> {
          return emit({
            type: "step-awaiting",
            runId: stepRunId,
            rootRunId,
            nodeId: node.id,
            nodeName: node.name,
            assignee: args.assignee,
          });
        },
        context(context): Promise<void> {
          return emit({
            type: "step-context",
            runId: stepRunId,
            rootRunId,
            nodeId: node.id,
            nodeName: node.name,
            context,
          });
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
          await emit({
            type: "step-finished",
            runId: stepRunId,
            rootRunId,
            nodeId: node.id,
            nodeName: node.name,
            status: "cancelled",
          });
        },
      };
    },
    child(childIdentity): Emitter {
      // Same masking sink, a fresh envelope — the child run's own identity, none of this run's.
      return createEmitter(childIdentity, emit);
    },
  };
}
