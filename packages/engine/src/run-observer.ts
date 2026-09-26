import type { JsonValue, LaunchFacts, RerunFromNodePathEntry } from "@path/schema";
import type { Trace } from "./condition.js";

/**
 * Thrown by `observe` to fail the run rather than crash — the audit-first policy for a log-backend write failure (mvp
 * spec §8.2); any other throw is a bug and propagates.
 */
export class ObserverError extends Error {}

/**
 * How a run/step ended, shared by `step-finished` and `run-finished`. A failure carries its `error`
 * (a binary step's embeds the exit code and stderr tail); `cancelled` has neither, its cause being
 * narrated by `run-cancelled` (mvp spec §5.6).
 */
export type RunOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error?: string }
  | { status: "cancelled" };

/**
 * One typed record of run activity the engine emits to its observer — the **full** set, distinct from the
 * narrower `LogEvent` narrative. Every observation is already secret-masked (mvp spec §8.3), carries all four
 * identity fields, and carries the payloads persistence writes to blobs; four members are never narrated.
 */
export type Observation =
  /**
   * A workflow-run begins, before any body node executes; a nested workflow-step's run is reported here, not as
   * `step-started`. A workflow-run has no worker of its own (ADR 0021 sub-14).
   */
  | {
      type: "run-started";
      runId: string;
      rootRunId: string;
      parentRunId: string | null;
      nodeId: string | null;
      nodeName: string | null;
      input: JsonValue;
      /**
       * A `while-do` iteration container's 1-based ordinal (ADR 0037), set only on a container's run-started;
       * persistence records it on the row's `iteration` column.
       */
      iteration?: number;
      /**
       * A goto pass container's 1-based ordinal (ADR 0054), set only on a pass's run-started; persistence records it
       * on the row's `pass` column.
       */
      pass?: number;
      /**
       * The predecessor's root run id, set only on a resumed tree's **root** run-started; the one identity fact
       * marking this fresh root as a successor.
       */
      resumedFromRootRunId?: string;
      /**
       * The rerun boundary (K) descent path a Resume-from-K successor resumed from (ADR 0032), as `{nodeId,
       * nodeName}[]`; set only on the successor's **root** run-started.
       */
      rerunFromNodePath?: RerunFromNodePathEntry[];
      /**
       * The operator's frozen launch facts (ADR 0046) — input override, masked config override, and the launch
       * worker-default table (ADR 0044) — set only on a root run-started whose launch supplied any of them.
       */
      launchFacts?: LaunchFacts;
      /**
       * The producing workflow's source identity (ADR 0006), set only on the root run-started; persistence writes the
       * trio to the root row's `workflow_id`/`workflow_name`/`workflow_path`.
       */
      workflowId?: string;
      workflowName?: string;
      workflowPath?: string;
    }
  | {
      type: "step-started";
      runId: string;
      rootRunId: string;
      parentRunId: string;
      nodeId: string;
      nodeName: string;
      stepType: string;
      /** The *name* of the worker this leaf step ran on (ADR 0021 sub-14): `spawn`/`anthropic`. */
      workerName: string;
      input: JsonValue;
    }
  /** A binary step's captured stderr — never passed downstream (format doc §4.2), audit only. */
  | {
      type: "step-stderr";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      stderr: string;
    }
  /**
   * What one LLM step run spent (mvp spec §5.7, §7): the worker's real token counts and the SDK's client-side cost
   * estimate. Leaf-only — subtree figures are a read-time SUM — and emitted before `step-finished`, for a failed step
   * too.
   */
  | {
      type: "step-usage";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      usage: JsonValue | null;
      estimatedCostUsd: number | null;
    }
  | ({
      type: "step-finished";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
    } & RunOutcome)
  | {
      type: "context-changed";
      runId: string;
      rootRunId: string;
      nodeId: string | null;
      nodeName: string | null;
      context: JsonValue;
    }
  /**
   * A leaf step run's snapshot of the enclosing workflow-run's context, taken right after the step finished and its
   * publish landed, written under the step run's own directory. Persistence-only, never narrated.
   */
  | {
      type: "step-context";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      context: JsonValue;
    }
  /**
   * A `parallel` join applied at block end: for `collect` all branches succeeded and their buffered publishes landed
   * in declaration order; for `wait-one` only the `winner` branch's landed.
   */
  | {
      type: "join-applied";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      branches: string[];
      publishedKeys: string[];
      winner?: string;
    }
  /**
   * A run the engine killed best-effort (mvp spec §5.6): `cause` is `sibling-failed` (with the failing run's id),
   * `sibling-succeeded`, or `operator`. Paired with a `cancelled` `step-finished`.
   */
  | {
      type: "run-cancelled";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      cause: "sibling-failed" | "sibling-succeeded" | "operator";
      causeRunId: string | null;
    }
  | ({
      type: "run-finished";
      runId: string;
      rootRunId: string;
      nodeId: string | null;
      nodeName: string | null;
    } & RunOutcome)
  /**
   * A resumed tree reused a node's recorded work instead of re-running it (resume-restore-semantics.md §6): this
   * marker is the reused node's whole trace, with no `step-started`/`step-finished` and no run row.
   */
  | {
      type: "reuse-marker";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      originalRunId: string;
    }
  /**
   * A leaf step run entered the `awaiting` status: the engine suspended it. `assignee` is the offline activity's
   * informational string, `null` when the node named none, and is secret-masked like any other.
   */
  | {
      type: "step-awaiting";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      assignee: string | null;
    }
  /**
   * A `checkpoint` node was evaluated: `passed` is the condition outcome (a strict-error evaluation is `passed:
   * false` with the error in `trace`), attributed to the enclosing run plus the control node's id.
   */
  | {
      type: "checkpoint-evaluated";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      passed: boolean;
      trace: Trace;
    }
  /**
   * A `branch` arm won: `arm` is the winning arm's index, or `else` for the fallback (which has no condition, so
   * `trace` is null).
   */
  | {
      type: "branch-taken";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      arm: number | "else";
      trace: Trace | null;
    }
  /**
   * No `branch` arm matched and there was no `else` — this fails the run (mvp spec §5.2). Carries every arm's
   * `trace`.
   */
  | {
      type: "branch-no-match";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      traces: Trace[];
    }
  | {
      type: "iteration-started";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      iteration: number;
      trace: Trace;
    }
  /**
   * A `while-do` loop exited: `reason` is `condition-false` or `max-iterations-exceeded` (which fails the run, mvp
   * spec §5.2/§5.6); `iterations` counts completed iterations.
   */
  | {
      type: "loop-exited";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      reason: "condition-false" | "max-iterations-exceeded";
      iterations: number;
      trace: Trace;
    }
  /**
   * A goto pass opened (ADR 0054, goto.md §7): `pass` is its 1-based ordinal; `nodeId`/`nodeName` name the goto that
   * opened it, both null for pass 1.
   */
  | {
      type: "pass-started";
      runId: string;
      rootRunId: string;
      nodeId: string | null;
      nodeName: string | null;
      pass: number;
    }
  /**
   * A goto jumped (ADR 0061): `jump` is this goto's 1-based count in the workflow-run, this one included; `maxJumps`
   * the resolved bound; `pass` the ordinal it opens.
   */
  | {
      type: "goto-taken";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      targetNodeId: string;
      targetNodeName: string;
      jump: number;
      maxJumps: number;
      pass: number;
    }
  /** A goto was reached with its `max_jumps` already spent (ADR 0061) — this fails the pass and the workflow-run. */
  | {
      type: "goto-exhausted";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      targetNodeId: string;
      targetNodeName: string;
      maxJumps: number;
      pass: number;
    };

/**
 * The engine's audit seam: one required method, called wherever persistence and logging need to observe, and the
 * engine never touches fs/db. One method rather than a hook per lifecycle point: a sink may ignore observations,
 * but a decorator that drops them would silently delete them. Observations are already masked (mvp spec §8.3).
 */
export interface RunObserver {
  observe(o: Observation): void | Promise<void>;
}

/**
 * Fans one observation out to several observers in argument order, awaiting each; a throw (e.g. `ObserverError`)
 * propagates, so observers after the thrower do not run. `Project.execute` orders the pipeline persistence →
 * logging → appended observers, so a failed audit still leaves the run row and the server's capture observer cannot
 * race the row or hub channel it reads.
 */
export function composeObservers(...observers: RunObserver[]): RunObserver {
  return {
    async observe(o) {
      for (const observer of observers) await observer.observe(o);
    },
  };
}
