import type { JsonValue, Worker } from "@path/schema";

/** How a run/step ended — shared by `stepFinished` and `runFinished` (identical shape). */
export type RunOutcome = { status: "succeeded"; output: JsonValue } | { status: "failed" };

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
   */
  runStarted?(info: {
    runId: string;
    rootRunId: string;
    parentRunId: string | null;
    nodeId: string | null;
    input: JsonValue;
  }): void | Promise<void>;
  /** A leaf step run begins — its input/command/cwd are resolved and it's about to execute. */
  stepStarted?(info: {
    runId: string;
    rootRunId: string;
    parentRunId: string;
    nodeId: string;
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
}
