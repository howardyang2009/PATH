import type { JsonValue, LaunchFacts, LogEvent, RerunFromNodePathEntry } from "@path/schema";

/**
 * Thrown by `observe` to fail the run rather than crash — the audit-first policy for a log-backend
 * write failure (mvp spec §8.2); any other throw is a bug and propagates.
 */
export class ObserverError extends Error {}

/**
 * How a run/step ended. A failure carries its `error` (a binary step's embeds the exit code and
 * stderr tail); `cancelled` has neither, its cause being narrated by `run-cancelled` (mvp spec
 * §5.6).
 */
export type RunOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error?: string }
  | { status: "cancelled" };

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A workflow-run's step type: it is its file's implicit root step, a reserved control name. */
export const WORKFLOW_STEP_TYPE = "workflow";

/** A `LogEvent` before the logging observer stamps its per-root-run `seq`. */
export type UnsequencedLogEvent = DistributiveOmit<LogEvent, "seq">;

/**
 * What persistence records and the log never carries (mvp spec §6): the blobs and the row facts
 * beyond the event. `started` rides a `step-started`, `output` a succeeded `step-finished`; the
 * other three stand alone.
 */
export type RunPayload =
  | {
      kind: "started";
      parentRunId: string | null;
      input: JsonValue;
      /** A `while-do` iteration container's 1-based ordinal (ADR 0037). */
      iteration?: number;
      /** A goto pass container's 1-based ordinal (ADR 0054). */
      pass?: number;
      /** Root-only: the predecessor's root run id on a resumed tree. */
      resumedFromRootRunId?: string;
      /** Root-only: the rerun boundary (K) descent path of a Resume-from-K successor (ADR 0032). */
      rerunFromNodePath?: RerunFromNodePathEntry[];
      /** Root-only: the operator's frozen launch facts (ADR 0046). */
      launchFacts?: LaunchFacts;
      /** Root-only: the producing workflow's source identity (ADR 0006). */
      workflowId?: string;
      workflowName?: string;
      workflowPath?: string;
    }
  | { kind: "output"; output: JsonValue }
  /** A binary step's captured stderr — audit only, never passed downstream (format doc §4.2). */
  | { kind: "stderr"; stderr: string }
  /** What one LLM step run spent (mvp spec §5.7); leaf-only, emitted before its `step-finished`. */
  | { kind: "usage"; usage: JsonValue | null; estimatedCostUsd: number | null }
  /** A workflow-run's context after a publish, or a leaf step run's snapshot of it at finish. */
  | { kind: "context"; context: JsonValue };

/**
 * One fact a run reports: the log event it narrates (`null` when only persistence records it) plus
 * the payload the log must not carry. `runId` is the run the fact is about; every fact is already
 * secret-masked (mvp spec §8.3).
 */
export interface RunEvent {
  runId: string;
  rootRunId: string;
  event: UnsequencedLogEvent | null;
  payload?: RunPayload;
}

/**
 * The engine's audit seam: one method, called wherever persistence and logging need to observe; the
 * engine never touches fs/db. A sink may ignore events, but a decorator that dropped them would
 * silently delete them.
 */
export interface RunObserver {
  observe(e: RunEvent): void | Promise<void>;
}

/**
 * Fans one event out to several observers in argument order, awaiting each; a throw (e.g.
 * `ObserverError`) propagates, so observers after the thrower do not run. `Project.execute` orders
 * the pipeline persistence → logging → appended observers, so a failed audit still leaves the run
 * row and the server's capture observer cannot race the row or hub channel it reads.
 */
export function composeObservers(...observers: RunObserver[]): RunObserver {
  return {
    async observe(e) {
      for (const observer of observers) await observer.observe(e);
    },
  };
}
