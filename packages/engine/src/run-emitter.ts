import { randomUUID } from "node:crypto";
import {
  isRootRun,
  type JsonValue,
  type LaunchFacts,
  type LogEvent,
  type RerunFromNodePathEntry,
} from "@path/schema";
import type { Emit, RunIdentity } from "./run-context.js";
import {
  type DistributiveOmit,
  type RunOutcome,
  type RunPayload,
  type UnsequencedLogEvent,
  WORKFLOW_STEP_TYPE,
} from "./run-observer.js";

/**
 * The run-scoped producer of `RunEvent`s: one per workflow-run, stamping the envelope (`run_id`,
 * `node_id`, `node_name`, `ts`, the root run id) so a call site supplies only what its log event
 * adds. It composes; `emit` masks (§8.3).
 */

/** The identity an event names its node by — the node's own `id`/`name`. */
export interface NodeRef {
  id: string;
  name: string;
}

/**
 * What a call site supplies: a `LogEvent` minus the envelope the emitter stamps. Lifecycle events
 * are excluded: only the lifecycle methods emit them, so a stray one cannot finish a row or close
 * the log.
 */
export type EventBody = DistributiveOmit<
  Exclude<LogEvent, { type: "step-started" | "step-finished" | "run-cancelled" }>,
  "seq" | "ts" | "run_id" | "node_id" | "node_name"
>;

type LifecycleBody = DistributiveOmit<
  Extract<LogEvent, { type: "step-started" | "step-finished" | "run-cancelled" }>,
  "seq" | "ts" | "run_id" | "node_id" | "node_name"
>;

/** A `step-finished` a step reaches on its own (not by cancellation): succeeded with output, or
 * failed. */
type StepFinish = Exclude<RunOutcome, { status: "cancelled" }>;

/** The standalone payloads: persistence records them with no log event. */
type RecordOnly = Extract<RunPayload, { kind: "stderr" | "usage" | "context" }>;

/**
 * A single leaf step run's events, all under one minted run id: `started`, then any
 * `record`/`emit`, then exactly one terminal — `finished`, or `cancelled`.
 */
export interface StepEmitter {
  /** This step run's own minted id — the `causeRunId` its failure hands its cancelling siblings. */
  readonly runId: string;
  started(args: { stepType: string; workerName: string; input: JsonValue }): Promise<void>;
  /** Narrate one event about this step run, e.g. `step-awaiting`. */
  emit(body: EventBody): Promise<void>;
  record(payload: RecordOnly): Promise<void>;
  finished(outcome: StepFinish): Promise<void>;
  /** The kill pair (§5.6): `run-cancelled` carrying the cause, then a `cancelled`
   * `step-finished`. */
  cancelled(args: {
    cause: "sibling-failed" | "sibling-succeeded" | "operator";
    causeRunId: string | null;
  }): Promise<void>;
}

/** The run-tier surface: this workflow-run's own lifecycle and the control-node events it
 * narrates. */
export interface Emitter {
  /**
   * This workflow-run begins, narrated as its implicit root step's `step-started`. The
   * source-workflow trio, the launch facts and the rerun path are root-only, gated on `isRoot`; a
   * nested run passes them and they are dropped.
   */
  runStarted(args: {
    input: JsonValue;
    resumedFromRootRunId?: string;
    rerunFromNodePath?: RerunFromNodePathEntry[];
    launchFacts?: LaunchFacts;
    workflowId?: string;
    workflowName?: string;
    workflowPath?: string;
  }): Promise<void>;
  runFinished(outcome: RunOutcome): Promise<void>;
  /** Narrate one event about `node` under this run's id; `null` names no node (goto pass 1). */
  emit(node: NodeRef | null, body: EventBody): Promise<void>;
  record(payload: RecordOnly): Promise<void>;
  /**
   * Open a step-scoped sub-emitter, minting a fresh run id. A Complete replay (ADR 0041) passes the
   * **existing** parked leaf's id, so its `step-finished` transitions that row in place.
   */
  step(node: NodeRef, existingRunId?: string): StepEmitter;
  /** The emitter for a nested workflow-run over this tree's same masking sink, enveloped by its own
   * `identity`. */
  child(identity: RunIdentity): Emitter;
}

/** Build the emitter for one workflow-run over the tree's masking `emit`; `identity` fixes its
 * envelope. */
export function createEmitter(identity: RunIdentity, emit: Emit): Emitter {
  const { runId, rootRunId, parentRunId, nodeId, nodeName, iteration, pass } = identity;
  const isRoot = isRootRun(identity);

  // Stamps one run's envelope onto a body; a `cancelled` or bare `failed` finish carries no
  // `error`.
  function send(
    run: string,
    node: { id: string | null; name: string | null },
    body: EventBody | LifecycleBody | null,
    payload?: RunPayload,
  ): Promise<void> {
    const event =
      body === null
        ? null
        : ({
            ...body,
            ts: new Date().toISOString(),
            run_id: run,
            node_id: node.id,
            node_name: node.name,
          } as UnsequencedLogEvent);
    return emit({ runId: run, rootRunId, event, ...(payload ? { payload } : {}) });
  }

  function finish(run: string, node: { id: string | null; name: string | null }, o: RunOutcome) {
    if (o.status === "succeeded")
      return send(
        run,
        node,
        { type: "step-finished", status: "succeeded" },
        {
          kind: "output",
          output: o.output,
        },
      );
    return send(run, node, {
      type: "step-finished",
      status: o.status,
      ...(o.status === "failed" && o.error !== undefined ? { error: o.error } : {}),
    });
  }

  const self = { id: nodeId, name: nodeName };

  return {
    runStarted(args): Promise<void> {
      return send(
        runId,
        self,
        { type: "step-started", step_type: WORKFLOW_STEP_TYPE, worker_name: WORKFLOW_STEP_TYPE },
        {
          kind: "started",
          parentRunId,
          input: args.input,
          ...(iteration !== undefined ? { iteration } : {}),
          ...(pass !== undefined ? { pass } : {}),
          // Successor lineage rides presence, not root-ness — the caller sets it on the root alone.
          ...(args.resumedFromRootRunId !== undefined
            ? { resumedFromRootRunId: args.resumedFromRootRunId }
            : {}),
          ...(isRoot && args.rerunFromNodePath !== undefined
            ? { rerunFromNodePath: args.rerunFromNodePath }
            : {}),
          ...(isRoot && args.launchFacts !== undefined ? { launchFacts: args.launchFacts } : {}),
          ...(isRoot && args.workflowId !== undefined ? { workflowId: args.workflowId } : {}),
          ...(isRoot && args.workflowName !== undefined ? { workflowName: args.workflowName } : {}),
          ...(isRoot && args.workflowPath !== undefined ? { workflowPath: args.workflowPath } : {}),
        },
      );
    },
    runFinished(outcome): Promise<void> {
      return finish(runId, self, outcome);
    },
    emit(node, body): Promise<void> {
      return send(runId, { id: node?.id ?? null, name: node?.name ?? null }, body);
    },
    record(payload): Promise<void> {
      return send(runId, self, null, payload);
    },
    step(node, existingRunId): StepEmitter {
      // Minted once and shared across the step's events; a Complete replay reuses the parked leaf's
      // id.
      const stepRunId = existingRunId ?? randomUUID();
      return {
        runId: stepRunId,
        started(args): Promise<void> {
          return send(
            stepRunId,
            node,
            { type: "step-started", step_type: args.stepType, worker_name: args.workerName },
            { kind: "started", parentRunId: runId, input: args.input },
          );
        },
        emit(body): Promise<void> {
          return send(stepRunId, node, body);
        },
        record(payload): Promise<void> {
          return send(stepRunId, node, null, payload);
        },
        finished(outcome): Promise<void> {
          return finish(stepRunId, node, outcome);
        },
        async cancelled(args): Promise<void> {
          await send(stepRunId, node, {
            type: "run-cancelled",
            cause: args.cause,
            cause_run_id: args.causeRunId,
          });
          await finish(stepRunId, node, { status: "cancelled" });
        },
      };
    },
    child(childIdentity): Emitter {
      return createEmitter(childIdentity, emit);
    },
  };
}
