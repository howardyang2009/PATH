import type { JsonValue, Worker } from "@path/schema";
import type { Trace } from "./condition.js";

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
 *
 * Every hook carries `rootRunId` — the id of the run tree's root — so one observer instance
 * serves an entire nested run tree (#22) without holding hidden per-run state: a nested
 * workflow-run's own `runStarted` no longer clobbers the observer's notion of "the root".
 */
export interface RunObserver {
  /**
   * A workflow-run begins, before any body node executes. The root run has `parentRunId: null`
   * and `nodeId: null`; a nested workflow-step's run (#22) carries its parent run's id and the
   * `workflow` node's id — workflow-as-step means the child run *is* that step's run, so a nested
   * workflow-run is reported here (with its own context) rather than through `stepStarted`.
   *
   * `worker` is this workflow-run's own file worker (inheritance never crosses the file
   * boundary) — every workflow-run is its file's implicit root workflow-step (invariant 2), so
   * logging (#19) emits its `step-started`/`step-finished` as the run's own lifecycle
   * (mvp spec §8.1).
   */
  runStarted?(info: {
    runId: string;
    rootRunId: string;
    parentRunId: string | null;
    nodeId: string | null;
    input: JsonValue;
    worker: Worker;
  }): void | Promise<void>;
  /** A leaf step run begins — its input/command/cwd are resolved and it's about to execute. */
  stepStarted?(info: {
    runId: string;
    rootRunId: string;
    parentRunId: string;
    nodeId: string;
    stepType: string;
    worker: Worker;
    input: JsonValue;
  }): void | Promise<void>;
  /** A binary step's captured stderr — never passed downstream (format doc §4.2), audit only. */
  stepStderr?(info: { runId: string; rootRunId: string; stderr: string }): void | Promise<void>;
  /** A leaf step run finished. */
  stepFinished?(info: { runId: string; rootRunId: string } & RunOutcome): void | Promise<void>;
  /** A workflow-run's context changed, after a publish landed — each workflow-run has its own. */
  contextChanged?(info: { runId: string; rootRunId: string; context: JsonValue }): void | Promise<void>;
  /** A workflow-run finished (root or nested). */
  runFinished?(info: { runId: string; rootRunId: string } & RunOutcome): void | Promise<void>;

  /**
   * A `checkpoint` node was evaluated (#21). Control-node events are attributed to the enclosing
   * workflow-step's run (`runId`) + the control node's `nodeId` — a checkpoint has no run of its
   * own (invariant 1). `passed` is the condition outcome; a strict-error evaluation is `passed:
   * false` with the error surfaced as an error leaf inside `trace`. Logging (#19) maps this to the
   * `checkpoint-passed`/`checkpoint-failed` event.
   */
  checkpointEvaluated?(info: {
    runId: string;
    rootRunId: string;
    nodeId: string;
    passed: boolean;
    trace: Trace;
  }): void | Promise<void>;
  /**
   * A `branch` arm won (#21): `arm` is the winning arm's index, or `"else"` for the fallback (which
   * has no condition, so `trace` is null). Logging maps this to `branch-taken`.
   */
  branchTaken?(info: {
    runId: string;
    rootRunId: string;
    nodeId: string;
    arm: number | "else";
    trace: Trace | null;
  }): void | Promise<void>;
  /**
   * No `branch` arm matched and there was no `else` (#21) — this fails the run (§5.2). Carries every
   * arm's `trace`. Logging maps this to `branch-no-match`.
   */
  branchNoMatch?(info: {
    runId: string;
    rootRunId: string;
    nodeId: string;
    traces: Trace[];
  }): void | Promise<void>;
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
    async checkpointEvaluated(info) {
      for (const o of observers) await o.checkpointEvaluated?.(info);
    },
    async branchTaken(info) {
      for (const o of observers) await o.branchTaken?.(info);
    },
    async branchNoMatch(info) {
      for (const o of observers) await o.branchNoMatch?.(info);
    },
  };
}
