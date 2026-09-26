import type {
  CompleteResult,
  LoadedStepPluginRegistry,
  LogBackend,
  LogBackendId,
  Project,
  RunObserver,
} from "@path/engine";
import type { ConfigObject, JsonValue, LogEvent, WorkflowFile } from "@path/schema";
import { createDeferred } from "./deferred.js";
import { createLiveLogBackend } from "./live-log-backend.js";
import { RunEventHub } from "./run-event-hub.js";

/**
 * The runs this server process is executing. Routes keep what a route owns (request in, status out).
 * Guarantees: `start` resolves once `run-started` has landed (row written, channel open); a started run
 * is cancellable until it settles; `stream` replays then goes live with no gap or duplicate.
 */
export interface LiveRuns {
  /** Starts one workflow and resolves with its ids once the root run exists — the 202 contract of
   * `POST /v0/runs` (server-api-v0.md §2). Rejects only if `run-started` never fires. */
  start(rootFile: WorkflowFile, workflowDir: string, options: StartRunOptions): Promise<StartedRun>;
  /** Resumes a prior root run as a **successor** (ADR 0001) and resolves with its own fresh ids; the
   * context is restored from the predecessor, so no `input`/`operatorConfig` is carried. */
  resume(
    rootFile: WorkflowFile,
    resumeRootRunId: string,
    workflowDir: string,
    options: ResumeRunOptions,
  ): Promise<StartedRun>;
  /** Signals a run's abort, best-effort (mvp spec §5.6). `false` means no run by that id executes here,
   * so the caller must not report a cancel it cannot perform; a second cancel still answers `true`. */
  cancel(rootRunId: string): boolean;
  /** Subscribes to a root run's stream: persisted replay after `afterSeq`, then live events. The
   * subscription precedes the replay read and every delivered `seq` is tracked, so nothing is missed. */
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
  /** Resolves once every run started here has settled — the drain a shutdown awaits before closing the
   * store, since runs are fire-and-forget and would otherwise lose their connection mid-step. */
  idle(): Promise<void>;
}

/** `Project.run`'s options, minus the audit seam and the extension points this module owns. */
export interface StartRunOptions {
  input?: { [key: string]: JsonValue };
  /**
   * The operator's override input as sent (ADR 0046); `input` is the effective seed and is never re-applied on a
   * continuation.
   */
  operatorInput?: JsonValue;
  operatorConfig?: ConfigObject;
  /** The operator's run-wide launch worker-default table (ADR 0044), spread into `Project.run`'s
   * `launchWorkerDefaults`; frozen with the run, so a resume carries none. */
  launchWorkerDefaults?: { [stepType: string]: string };
  files: Map<string, WorkflowFile>;
  /** The registry the workflow was validated against, forwarded so the run dispatches without re-scanning. */
  registry: LoadedStepPluginRegistry;
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  /** The root workflow file's project-relative path, recorded so a later `resume` can recover the file. */
  sourceWorkflowPath?: string;
}

/**
 * What `resume` needs beyond the predecessor id: the workflow structure and the same backend overrides as `start`.
 */
export interface ResumeRunOptions {
  files: Map<string, WorkflowFile>;
  registry: LoadedStepPluginRegistry;
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  /**
   * An optional config override (§4.3): unlike `input`, operator config is merged over the declared config for re-run
   * steps.
   */
  operatorConfig?: ConfigObject;
  /** Recorded on the successor's root row so a resumed run is itself resumable (see `StartRunOptions`). */
  sourceWorkflowPath?: string;
  /** The rerun boundary K's source run id (ADR 0032), forwarded verbatim to `Project.resume`; absent = plain Resume. */
  rerunFromRunId?: string;
}

/**
 * What `complete` needs beyond the leaf id and its output: the reloaded workflow structure and the backend overrides.
 */
export interface CompleteRunOptions {
  files: Map<string, WorkflowFile>;
  registry: LoadedStepPluginRegistry;
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  /**
   * An optional config override for the continued run (ADR 0046); it is how a frozen `$secret` value is supplied
   * again.
   */
  operatorConfig?: ConfigObject;
}

/** Thrown by `resume` when the engine reports the predecessor root run id unknown. */
export class ResumeNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeNotFound";
  }
}

/** Thrown by `resume` when `Project.resume` refuses a Resume-from-K selection (ADR 0032), carrying its status. */
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
 * One `LiveRuns` per server process, over the process's one `Project`; runs execute in-process (server-api-v0.md §0).
 */
export function createLiveRuns(project: Project): LiveRuns {
  const hub = new RunEventHub();
  /**
   * The root runs executing here with the `AbortController` whose signal went to `runWorkflow`; filed and dropped per
   * outcome.
   */
  const controllers = new Map<string, AbortController>();

  /**
   * Every in-flight run's own promise; each removes itself on settle, so `idle` drains the set. The chain never
   * rejects.
   */
  const inFlight = new Set<Promise<void>>();
  function track(runChain: Promise<void>): void {
    const entry = runChain.finally(() => inFlight.delete(entry));
    inFlight.add(entry);
  }

  /** The tracking `start` and `resume` share: the `run-started` deferred, the controller filed for
   * `cancel`, the live-forwarding backend, and the teardown that drops both on any outcome. */
  function beginTracked(): {
    started: ReturnType<typeof createDeferred<StartedRun>>;
    hooks: {
      extraBackends: LogBackend[];
      extraObservers: RunObserver[];
      signal: AbortSignal;
      warn: (message: string) => void;
    };
    finalize: () => void;
  } {
    // Resolved on the first `run-started`: the response goes out before the run finishes, not before it starts.
    const started = createDeferred<StartedRun>();
    const controller = new AbortController();
    let registeredRootRunId: string | undefined;

    const captureObserver: RunObserver = {
      observe(o) {
        if (o.type !== "run-started") return;
        // Fires for every run in the tree, all sharing one `rootRunId` — register on the first.
        if (registeredRootRunId === undefined) {
          registeredRootRunId = o.rootRunId;
          controllers.set(o.rootRunId, controller);
        }
        started.resolve({ runId: o.runId, rootRunId: o.rootRunId });
      },
    };

    return {
      started,
      hooks: {
        // Lets subscribers (§5) see every event in `seq` order; never throws, so it cannot fail the run.
        extraBackends: [createLiveLogBackend(hub)],
        // Appended after persistence: this resolves the deferred, so a caller may read the run the moment it does.
        extraObservers: [captureObserver],
        signal: controller.signal,
        warn: (message) => console.error(`warning: ${message}`),
      },
      // Tearing both registries down here makes "on every outcome" true by construction.
      finalize: () => {
        if (registeredRootRunId === undefined) return; // never started; neither holds an entry
        controllers.delete(registeredRootRunId);
        // Backstop for the one path with no terminal event (a `runWorkflow` rejection); idempotent.
        hub.close(registeredRootRunId);
      },
    };
  }

  return {
    async start(rootFile, workflowDir, options): Promise<StartedRun> {
      const { started, hooks, finalize } = beginTracked();
      // Fire-and-forget: the run keeps executing after `start` resolves; a rejection also settles `started`.
      track(
        project
          .run(rootFile, workflowDir, { ...options, ...hooks })
          .then(
            (result) => {
              if (result.status === "failed") console.error(`run failed: ${result.error}`);
            },
            (err) => {
              started.reject(err);
              console.error(`run crashed: ${err instanceof Error ? err.stack : String(err)}`);
            },
          )
          .finally(finalize),
      );

      return started.promise;
    },

    async resume(rootFile, resumeRootRunId, workflowDir, options): Promise<StartedRun> {
      const { started, hooks, finalize } = beginTracked();
      track(
        project
          .resume(rootFile, resumeRootRunId, workflowDir, { ...options, ...hooks })
          .then(
            (result) => {
              // No successor started: reject with the shape the route branches on (refusal, or 404).
              if (!result.found) {
                started.reject(
                  "refusal" in result
                    ? new ResumeRefused(result.refusal.status, result.refusal.message)
                    : new ResumeNotFound(result.error),
                );
                return;
              }
              if (result.status === "failed") console.error(`resumed run failed: ${result.error}`);
            },
            (err) => {
              started.reject(err);
              console.error(
                `resumed run crashed: ${err instanceof Error ? err.stack : String(err)}`,
              );
            },
          )
          .finally(finalize),
      );

      return started.promise;
    },

    cancel(rootRunId: string): boolean {
      const controller = controllers.get(rootRunId);
      if (!controller) return false;
      // A second cancel of a still-unwinding run is a no-op that still answers `true`.
      controller.abort();
      return true;
    },

    async complete(
      rootFile,
      rootRunId,
      stepRunId,
      output,
      workflowDir,
      options,
    ): Promise<CompleteResult> {
      // A Complete re-drives the existing tree (ADR 0041), so no fresh `run-started` exists — file the
      // controller under the known root id so Cancel reaches the tail, and stream the tail live.
      const controller = new AbortController();
      // Own the controller/channel only when no drive is active for this root: a concurrent Complete the
      // engine lease rejects must not clobber the live drive's controller or close its subscribers.
      const owns = !controllers.has(rootRunId);
      if (owns) controllers.set(rootRunId, controller);
      const drive = project.complete(rootFile, stepRunId, output, workflowDir, {
        ...options,
        extraBackends: [createLiveLogBackend(hub)],
        signal: controller.signal,
        warn: (message) => console.error(`warning: ${message}`),
      });
      // Track the whole drive so a graceful shutdown drains it; it settles either way, so never rejects.
      track(
        drive.then(
          () => {},
          () => {},
        ),
      );
      try {
        return await drive;
      } finally {
        if (owns) {
          controllers.delete(rootRunId);
          // Backstop for a rejection (no drive ran) or a missing terminal; idempotent and channel-safe.
          hub.close(rootRunId);
        }
      }
    },

    stream(
      rootRunId: string,
      afterSeq: number | undefined,
      handlers: RunStreamHandlers,
    ): Unsubscribe {
      // High-water mark across replay and live: anything at or below it is dropped, so nothing is sent twice.
      let lastSeq = afterSeq ?? 0;
      let live = false;
      const buffered: LogEvent[] = [];

      function deliver(event: LogEvent): void {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        handlers.onEvent(event);
      }

      // Subscribe *before* reading history: a publish landing mid-read is buffered, so nothing is missed.
      const unsubscribe = hub.subscribe(
        rootRunId,
        (event) => (live ? deliver(event) : buffered.push(event)),
        handlers.onEnd,
      );

      for (const event of project.archive.tree(rootRunId)?.events(afterSeq) ?? []) deliver(event);
      for (const event of buffered) deliver(event);
      live = true;

      // No open channel: the run is terminal, not executing here, or never existed — the replay is all.
      if (unsubscribe === null) {
        handlers.onEnd();
        return () => {};
      }

      return unsubscribe;
    },

    get cancellable(): number {
      return controllers.size;
    },

    async idle(): Promise<void> {
      // Loop: a run tracked at snapshot time can settle while we await, so drain until the set is empty.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
