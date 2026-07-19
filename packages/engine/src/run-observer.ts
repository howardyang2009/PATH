import type { JsonValue, Worker } from "@path/schema";

/** How a run/step ended — shared by `stepFinished` and `runFinished` (identical shape). */
export type RunOutcome = { status: "succeeded"; output: JsonValue } | { status: "failed" };

/**
 * Lifecycle hooks `runWorkflow` calls at exactly the points persistence (#18) and later logging
 * (#19) need to observe. The engine itself never touches fs/db directly — a caller with nothing
 * to observe passes no observer at all, and every hook is independently optional so a caller
 * only implements what it needs.
 */
export interface RunObserver {
  /** The root run begins, before any body node executes. */
  runStarted?(info: { runId: string; input: JsonValue }): void | Promise<void>;
  /** A step run begins — its input/command/cwd are resolved and it's about to execute. */
  stepStarted?(info: {
    runId: string;
    parentRunId: string;
    nodeId: string;
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
