import type { ConfigObject, JsonValue, RunRecord, WorkflowFile } from "@path/schema";
import type { LoadedStepPluginRegistry } from "./plugin-seam/scan.js";
import type { WorkerDescriptor } from "./plugin-seam/seam.js";
import type { RunObserver } from "./run-observer.js";

/** The public inputs and result of `runWorkflow`. */

/** Test/host worker overrides (ADR 0021 sub-15): `(type, worker-name)` → descriptor, merged
 * **replace-only**. */
export type WorkerOverrides = { [type: string]: { [name: string]: WorkerDescriptor } };

/** The seams and settings every entry point accepts, whichever mode it runs in. */
export interface RunSeams {
  /** The seed a fresh run starts from; a continuation's context comes from its own seed or the
   * predecessor, so this is only the fallback. */
  input?: { [key: string]: JsonValue };
  operatorConfig?: ConfigObject;
  files?: Map<string, WorkflowFile>;
  observer?: RunObserver;
  warn?: (message: string) => void;
  /** Replace named `(type, worker)` pairs in the scanned registry before dispatch — replace-only
   * (ADR 0021 sub-15). */
  workerOverrides?: WorkerOverrides;
  /**
   * Launch worker-default table (ADR 0044): run-wide, above `file.worker_defaults`, below an
   * explicit `node.worker` pin.
   */
  launchWorkerDefaults?: { [stepType: string]: string };
  /**
   * The frozen step-plugin registry this run dispatches against; absent means the run scans the
   * folder (ADR 0019 sub-15).
   */
  registry?: LoadedStepPluginRegistry;
  /** Plugin folder for the self-scan fallback; consulted only when `registry` is absent (ADR 0019
   * sub-8). */
  stepPluginsDir?: string;
  /** Engine-wide Processor cap (mvp spec §5.5), default 4 — one semaphore for the whole run
   * tree. */
  processorConcurrency?: number;
  /**
   * External abort: kills this root run's in-flight leaf steps best-effort, ending it `cancelled`;
   * already-aborted cancels at once (§5.6).
   */
  signal?: AbortSignal;
  sourceWorkflowPath?: string;
}

/**
 * A fresh **launch** (ADR 0046): the operator's **override input** is identity-defining, so it has
 * a home here and only here — a continuation restores the Context blackboard and never re-applies
 * one.
 */
export interface LaunchRunOptions extends RunSeams {
  operatorInput?: JsonValue;
  unresolvedLaunchSecrets?: undefined;
  inheritedLaunchSecretKeys?: undefined;
  continuation?: undefined;
}

/**
 * A **continuation** — Resume mints a successor (ADR 0062), Complete replays this tree in place
 * (ADR 0041). The seed is the predecessor's, so `operatorInput` has no effect and, typed
 * `undefined`, no way to be passed: the launch facts a successor records cannot claim an input
 * override it never applied.
 */
export interface ContinuationRunOptions extends RunSeams {
  operatorInput?: undefined;
  /**
   * Frozen launch-config secrets the continuation did not supply again (ADR 0046); the run ends
   * before its first step naming them.
   */
  unresolvedLaunchSecrets?: string[];
  /** The `secretKeys` a continuation inherited (ADR 0046), so its own frozen copy still marks
   * them. */
  inheritedLaunchSecretKeys?: string[];
  continuation: ContinuationInput;
}

/** What `runWorkflow` is asked to do: a launch, or a continuation of an existing tree. */
export type RunOptions = LaunchRunOptions | ContinuationRunOptions;

/**
 * What a successor run needs from the original tree: its run rows plus a reader for one blob. The
 * engine core does no I/O.
 */
export interface ResumeInput {
  originalRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  /** The **rerun boundary (K)** as the descent path of node ids (ADR 0032/0036): empty/undefined is
   * plain Resume. */
  rerunFromNodePath?: string[];
  /** Beside `rerunFromNodePath`, level for level: the goto pass K's path-node sits in, or `null`
   * (ADR 0054 §6). */
  rerunFromPasses?: (number | null)[];
}

/**
 * What a Complete re-invocation needs (ADR 0041): the tree's rows, a blob reader, and the parked
 * leaf to transition.
 */
export interface ContinueInput {
  rootRunId: string;
  existingRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  target: { stepRunId: string; output: JsonValue };
}

/** The one continuation a run is launched with: `resume` reuses a predecessor tree by node id,
 * `complete` re-drives this same tree in place. */
export type ContinuationInput =
  | ({ kind: "resume" } & ResumeInput)
  | ({ kind: "complete" } & ContinueInput);

// A failed run still carries the last-succeeded node's output, so `output` is unconditional.
export interface RunResult {
  // `awaiting` is **not** terminal: the run parked at a person-activity leaf and a later Complete
  // reopens it (ADR 0039/0041).
  status: "succeeded" | "failed" | "cancelled" | "awaiting";
  /**
   * On success the workflow's `output` map (format doc §6.4; absent = `{}`), **real**, secrets
   * included — the run's product.
   */
  output: JsonValue;
  error?: string;
}
