import {
  type CompleteResult,
  type LoadedStepPluginRegistry,
  type LogBackend,
  type LogBackendId,
  type Project,
  type RunObserver,
  type UserSecrets,
  WORKFLOW_STEP_TYPE,
} from "@path/engine";
import type { ConfigObject, JsonValue, LogEvent, WorkflowFile } from "@path/schema";
import { createDeferred } from "./deferred.js";
import { createLiveLogBackend } from "./live-log-backend.js";
import { RunEventHub, streamRun } from "./run-event-hub.js";

/**
 * The runs this server process is executing. Routes keep what a route owns (request in, status
 * out). Guarantees: `start` resolves once the root run's start has landed (row written, channel
 * open); a started run is cancellable until it settles; `stream` replays then goes live with no gap
 * or duplicate.
 */
export interface LiveRuns {
  /** Starts one workflow and resolves with its ids once the root run exists — the 202 contract of
   * `POST /v0/runs` (server-api-v0.md §2). Rejects only if the start never fires. */
  start(rootFile: WorkflowFile, workflowDir: string, options: StartRunOptions): Promise<StartedRun>;
  /** Resumes a prior root run as a **successor** (ADR 0001) and resolves with its own fresh ids;
   * the context is restored from the predecessor, so no `input`/`operatorConfig` is carried. */
  resume(
    rootFile: WorkflowFile,
    resumeRootRunId: string,
    workflowDir: string,
    options: ResumeRunOptions,
  ): Promise<StartedRun>;
  /** Signals a run's abort, best-effort (mvp spec §5.6). `false` means no run by that id executes
   * here, so the caller must not report a cancel it cannot perform; a second cancel still answers
   * `true`. */
  cancel(rootRunId: string): boolean;
  /** Subscribes to a root run's stream: persisted replay after `afterSeq`, then live events. The
   * subscription precedes the replay read and every delivered `seq` is tracked, so nothing is
   * missed. */
  stream(rootRunId: string, afterSeq: number | undefined, handlers: RunStreamHandlers): Unsubscribe;
  /** Completes a parked `awaiting` leaf (ADR 0041) by replaying the appendable tree to it, writing
   * `output` and driving the tail, which streams live and stays cancellable. */
  complete(
    rootFile: WorkflowFile,
    rootRunId: string,
    stepRunId: string,
    output: JsonValue,
    workflowDir: string,
    options: CompleteRunOptions,
  ): Promise<CompleteResult>;
  /** How many runs are cancellable here — 0 once every started run has settled. */
  readonly cancellable: number;
  /** Resolves once every run started here has settled — the drain a shutdown awaits before closing
   * the store, since runs are fire-and-forget and would otherwise lose their connection
   * mid-step. */
  idle(): Promise<void>;
}

/** `Project.run`'s options, minus the audit seam and the extension points this module owns. */
export interface StartRunOptions {
  input?: { [key: string]: JsonValue };
  /**
   * The operator's override input as sent (ADR 0046); `input` is the effective seed and is never
   * re-applied on a continuation.
   */
  operatorInput?: JsonValue;
  operatorConfig?: ConfigObject;
  /** The operator's run-wide launch worker-default table (ADR 0044), spread into `Project.run`'s
   * `launchWorkerDefaults`; frozen with the run, so a resume carries none. */
  launchWorkerDefaults?: { [stepType: string]: string };
  files: Map<string, WorkflowFile>;
  /** The registry the workflow was validated against, forwarded so the run dispatches without
   * re-scanning. */
  registry: LoadedStepPluginRegistry;
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  /** The root workflow file's project-relative path, recorded so a later `resume` can recover the
   * file. */
  sourceWorkflowPath?: string;
  /** The launcher's User secrets in hosted mode (ADR 0089), read at this call: `$env` resolves
   * against them instead of the host environment. */
  userSecrets?: UserSecrets;
}

/**
 * What `resume` needs beyond the predecessor id: the workflow structure and the same backend
 * overrides as `start`.
 */
export interface ResumeRunOptions {
  files: Map<string, WorkflowFile>;
  registry: LoadedStepPluginRegistry;
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  /**
   * An optional config override (§4.3): unlike `input`, operator config is merged over the declared
   * config for re-run steps.
   */
  operatorConfig?: ConfigObject;
  /** Recorded on the successor's root row so a resumed run is itself resumable (see
   * `StartRunOptions`). */
  sourceWorkflowPath?: string;
  /** The rerun boundary K's source run id (ADR 0032), forwarded verbatim to `Project.resume`;
   * absent = plain Resume. */
  rerunFromRunId?: string;
  /** As `StartRunOptions.userSecrets`, read again at this call. */
  userSecrets?: UserSecrets;
}

/**
 * What `complete` needs beyond the leaf id and its output: the reloaded workflow structure and the
 * backend overrides.
 */
export interface CompleteRunOptions {
  files: Map<string, WorkflowFile>;
  registry: LoadedStepPluginRegistry;
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  /**
   * An optional config override for the continued run (ADR 0046); it is how a frozen `$secret`
   * value is supplied again.
   */
  operatorConfig?: ConfigObject;
  /** As `StartRunOptions.userSecrets`, read again at this call. */
  userSecrets?: UserSecrets;
}

/** Thrown by `resume` when the engine reports the predecessor root run id unknown. */
export class ResumeNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeNotFound";
  }
}

/** Thrown by `resume` when `Project.resume` refuses a Resume-from-K selection (ADR 0032), carrying
 * its status. */
export class ResumeRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ResumeRefused";
  }
}

export interface StartedRun {
  runId: string;
  rootRunId: string;
}

export interface RunStreamHandlers {
  onEvent(event: LogEvent): void;
  /** No more events will come. Fires exactly once. */
  onEnd(): void;
}

export type Unsubscribe = () => void;

/**
 * What a run gets from the `LiveRuns` that drives it: the signal a cancel aborts, the moment its
 * root exists, and where its events fan out to subscribers.
 */
export interface RunDrive {
  /** Aborted when the run is cancelled. */
  readonly signal: AbortSignal;
  /** Whether another drive of this root is live here; only a Complete can meet one. */
  readonly held: boolean;
  /** The tree's root exists: resolves `start` or `resume`, files the root for cancel and opens its
   * channel. Only the first call counts. */
  started(run: StartedRun): void;
  /** Fans one event of the root out to its subscribers. */
  publish(event: LogEvent): void;
  /** A log backend that publishes each event it is written, for an engine that runs here. */
  readonly backend: LogBackend;
}

/**
 * Where a run executes, behind `LiveRuns` (ADR 0091): in process, or in a VM per invocation. An
 * executor's `start` and `resume` settle when the run does; a rejection before `drive.started`
 * rejects the launch.
 */
export interface RunExecutor {
  start(
    rootFile: WorkflowFile,
    workflowDir: string,
    options: StartRunOptions,
    drive: RunDrive,
  ): Promise<unknown>;
  resume(
    rootFile: WorkflowFile,
    resumeRootRunId: string,
    workflowDir: string,
    options: ResumeRunOptions,
    drive: RunDrive,
  ): Promise<unknown>;
  complete(
    rootFile: WorkflowFile,
    rootRunId: string,
    stepRunId: string,
    output: JsonValue,
    workflowDir: string,
    options: CompleteRunOptions,
    drive: RunDrive,
  ): Promise<CompleteResult>;
  /** Events a running root sent that the store does not hold yet, for a stream's replay. */
  unstored?(rootRunId: string): readonly LogEvent[];
}

/**
 * The runs one store executes, over `executor`: one owner for the live channels, the cancel
 * registry, Complete's ownership of a root, and the drain a shutdown awaits.
 */
export function liveRunsOver(store: Project, executor: RunExecutor): LiveRuns {
  const hub = new RunEventHub();
  /** Each root driven here, with the controller its cancel aborts. */
  const drives = new Map<string, AbortController>();
  /** Every in-flight drive; each removes itself on settle, so `idle` drains the set. */
  const inFlight = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>): void {
    const entry = work.finally(() => inFlight.delete(entry)).catch(() => {});
    inFlight.add(entry);
  }

  /** A new tree: resolves once its root exists, and keeps the root filed until the run settles. */
  function launch(run: (drive: RunDrive) => Promise<unknown>): Promise<StartedRun> {
    const started = createDeferred<StartedRun>();
    const controller = new AbortController();
    let rootRunId: string | undefined;
    const drive: RunDrive = {
      signal: controller.signal,
      held: false,
      started(ids) {
        if (rootRunId !== undefined) return;
        rootRunId = ids.rootRunId;
        drives.set(rootRunId, controller);
        hub.open(rootRunId);
        started.resolve(ids);
      },
      publish(event) {
        if (rootRunId !== undefined) hub.publish(rootRunId, event);
      },
      backend: createLiveLogBackend(hub),
    };
    track(
      run(drive)
        .catch((err) => started.reject(err))
        .finally(() => {
          if (rootRunId === undefined) return;
          drives.delete(rootRunId);
          // Backstop for a run that ended with no terminal event; idempotent.
          hub.close(rootRunId);
        }),
    );
    return started.promise;
  }

  return {
    start: (rootFile, workflowDir, options) =>
      launch((drive) => executor.start(rootFile, workflowDir, options, drive)),

    resume: (rootFile, resumeRootRunId, workflowDir, options) =>
      launch((drive) => executor.resume(rootFile, resumeRootRunId, workflowDir, options, drive)),

    async complete(rootFile, rootRunId, stepRunId, output, workflowDir, options) {
      // A Complete re-drives an existing tree (ADR 0041): it files the known root so Cancel
      // reaches the tail, unless a live drive of that root already owns its controller and channel.
      const held = drives.has(rootRunId);
      const controller = new AbortController();
      if (!held) {
        drives.set(rootRunId, controller);
        hub.open(rootRunId);
      }
      const work = executor.complete(rootFile, rootRunId, stepRunId, output, workflowDir, options, {
        signal: controller.signal,
        held,
        started: () => {},
        publish: (event) => hub.publish(rootRunId, event),
        backend: createLiveLogBackend(hub),
      });
      track(work);
      try {
        return await work;
      } finally {
        if (!held) {
          drives.delete(rootRunId);
          hub.close(rootRunId);
        }
      }
    },

    cancel(rootRunId) {
      const controller = drives.get(rootRunId);
      if (!controller) return false;
      // A second cancel of a still-unwinding run is a no-op that still answers `true`.
      controller.abort();
      return true;
    },

    stream(rootRunId, afterSeq, handlers) {
      // The store's narrative, then what the executor sent past it.
      const history = (after: number | undefined): LogEvent[] => {
        const stored = store.archive.tree(rootRunId)?.events(after) ?? [];
        const unstored = executor.unstored?.(rootRunId) ?? [];
        const from = Math.max(after ?? 0, stored.at(-1)?.seq ?? 0);
        return [...stored, ...unstored.filter((event) => event.seq > from)];
      };
      return streamRun(hub, history, rootRunId, afterSeq, handlers);
    },

    get cancellable() {
      return drives.size;
    },

    async idle() {
      // A drive tracked at snapshot time can settle while we await, so drain until none is left.
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

/** The in-process `LiveRuns` of local mode (server-api-v0.md §0): runs execute in this process. */
export function createLiveRuns(project: Project): LiveRuns {
  return liveRunsOver(project, inProcessExecutor(project));
}

/** Runs each operation through the engine in this process. */
export function inProcessExecutor(project: Project): RunExecutor {
  const warn = (message: string): void => console.error(`warning: ${message}`);
  /** Files the root as soon as its implicit root step starts: a workflow-run's start. */
  const startObserver = (drive: RunDrive): RunObserver => ({
    observe({ runId, rootRunId, event }) {
      if (event?.type === "step-started" && event.step_type === WORKFLOW_STEP_TYPE) {
        drive.started({ runId, rootRunId });
      }
    },
  });
  const hooks = (drive: RunDrive) => ({
    // Lets subscribers (§5) see every event in `seq` order; never throws, so it cannot fail the run.
    extraBackends: [drive.backend],
    // Appended after persistence, so a caller may read the run the moment `start` resolves.
    extraObservers: [startObserver(drive)],
    signal: drive.signal,
    warn,
  });
  const crashed = (what: string) => (err: unknown) => {
    console.error(`${what} crashed: ${err instanceof Error ? err.stack : String(err)}`);
    throw err;
  };

  return {
    start: (rootFile, workflowDir, options, drive) =>
      project.run(rootFile, workflowDir, { ...options, ...hooks(drive) }).then((result) => {
        if (result.status === "failed") console.error(`run failed: ${result.error}`);
      }, crashed("run")),

    resume: (rootFile, resumeRootRunId, workflowDir, options, drive) =>
      project
        .resume(rootFile, resumeRootRunId, workflowDir, { ...options, ...hooks(drive) })
        .then((result) => {
          // No successor started: the refusal, or a 404, is the launch's rejection.
          if (!result.found) {
            throw "refusal" in result
              ? new ResumeRefused(result.refusal.status, result.refusal.message)
              : new ResumeNotFound(result.error);
          }
          if (result.status === "failed") console.error(`resumed run failed: ${result.error}`);
        }, crashed("resumed run")),

    // A concurrent Complete is refused by the engine's own lease, not here.
    complete: (rootFile, _rootRunId, stepRunId, output, workflowDir, options, drive) =>
      project.complete(rootFile, stepRunId, output, workflowDir, {
        ...options,
        extraBackends: [drive.backend],
        signal: drive.signal,
        warn,
      }),
  };
}
