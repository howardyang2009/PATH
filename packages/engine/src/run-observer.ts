import type { JsonValue, Worker } from "@path/schema";

/**
 * Thrown by an observer hook to signal the engine must **fail the run** rather than crash — the
 * audit-first policy for a log backend write failure (mvp spec §8.2). `runWorkflow` catches this
 * specific type, ends the run as failed, and drives a best-effort terminal `runFinished`; any other
 * thrown error is treated as a bug and propagates unchanged.
 */
export class ObserverError extends Error {}

/**
 * How a run/step ended — shared by `stepFinished` and `runFinished` (identical shape). A failure
 * carries its `error` message so logging (#19) can put it on the `step-finished` event; for a
 * binary step that message already embeds the exit code + short stderr tail (mvp spec §8.1).
 */
export type RunOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error?: string };

/**
 * Lifecycle hooks `runWorkflow` calls at exactly the points persistence (#18) and later logging
 * (#19) need to observe. The engine itself never touches fs/db directly — a caller with nothing
 * to observe passes no observer at all, and every hook is independently optional so a caller
 * only implements what it needs.
 */
export interface RunObserver {
  /**
   * The root run begins, before any body node executes. `worker` is the top-level workflow's
   * worker — the root is the implicit root workflow-step (invariant 2), so logging emits its
   * `step-started`/`step-finished` as the run's own lifecycle (mvp spec §8.1).
   */
  runStarted?(info: { runId: string; input: JsonValue; worker: Worker }): void | Promise<void>;
  /** A step run begins — its input/command/cwd are resolved and it's about to execute. */
  stepStarted?(info: {
    runId: string;
    parentRunId: string;
    nodeId: string;
    stepType: string;
    worker: Worker;
    input: JsonValue;
  }): void | Promise<void>;
  /** A binary step's captured stderr — never passed downstream (format doc §4.2), audit only. */
  stepStderr?(info: { runId: string; stderr: string }): void | Promise<void>;
  /** A step run finished. */
  stepFinished?(info: { runId: string } & RunOutcome): void | Promise<void>;
  /** The (root) workflow-run's context changed, after a publish landed. */
  contextChanged?(info: { runId: string; context: JsonValue }): void | Promise<void>;
  /** The root run finished. */
  runFinished?(info: { runId: string } & RunOutcome): void | Promise<void>;
}

/**
 * Fans one lifecycle out to several observers in order, awaiting each — how the CLI drives both
 * persistence (#18) and logging (#19) off the single `options.observer` slot. A thrown hook
 * (e.g. an `ObserverError` from a log backend failure) propagates from the composite, so the engine
 * still sees it and fails the run.
 */
export function composeObservers(...observers: RunObserver[]): RunObserver {
  return {
    async runStarted(info) {
      for (const o of observers) await o.runStarted?.(info);
    },
    async stepStarted(info) {
      for (const o of observers) await o.stepStarted?.(info);
    },
    async stepStderr(info) {
      for (const o of observers) await o.stepStderr?.(info);
    },
    async stepFinished(info) {
      for (const o of observers) await o.stepFinished?.(info);
    },
    async contextChanged(info) {
      for (const o of observers) await o.contextChanged?.(info);
    },
    async runFinished(info) {
      for (const o of observers) await o.runFinished?.(info);
    },
  };
}
