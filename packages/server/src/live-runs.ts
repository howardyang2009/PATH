import type { LogBackendId, Project, RunObserver } from "@path/engine";
import type { ConfigObject, JsonValue, LogEvent, WorkflowFile } from "@path/schema";
import { createDeferred } from "./deferred.js";
import { createLiveLogBackend } from "./live-log-backend.js";
import { RunEventHub } from "./run-event-hub.js";

/**
 * The runs this server process is executing, for as long as it is executing them.
 *
 * **What this module exists to own.** Starting a run over HTTP is not one call to `Project.run`: it
 * is a run started, an id answered before the run finishes, a controller filed so the run can be
 * cancelled, a live channel opened so clients can watch, and both of those torn down however the
 * run ends. That behaviour was spread across five modules — `post-runs.ts` assembled the deferred,
 * the capture observer and the two registries; `get-run-events.ts` merged replay with live;
 * `cancel-run.ts` reached into the controllers; `run-event-hub.ts` and `live-log-backend.ts` held
 * the channel — and none of it could be exercised without binding a port. The registry lifecycle
 * could not be observed through the HTTP surface at all, so its tests drove a route handler with a
 * hand-built request and response.
 *
 * What the routes keep is what a route owns: reading a request, choosing a status code, framing a
 * response. Nothing here knows about either.
 *
 * **The guarantees this interface makes**, each of which used to be a comment a caller upheld:
 *
 * - `start` resolves once the run's `run-started` has landed — after its row is written and after
 *   its live channel is open, so a client may `GET` the run or subscribe the instant it returns.
 * - A started run is cancellable until it settles, and only until it settles, however it settles —
 *   including the one path with no terminal event, a `runWorkflow` that rejects with a bug (#74).
 * - `stream` delivers persisted replay then live events with no gap and no duplicate, whatever
 *   lands mid-read.
 */
export interface LiveRuns {
  /**
   * Starts one workflow and resolves with its ids as soon as the root run exists — the async
   * contract behind `POST /v0/runs`' 202 (server-api-v0.md §2). The returned promise rejects only
   * when the run never reached `run-started`; a run that starts and *then* fails resolves normally,
   * because by then the client has an id to watch.
   *
   * `workflowDir` is the root workflow file's own directory, not the project directory — see
   * `Project.run`.
   */
  start(rootFile: WorkflowFile, workflowDir: string, options: StartRunOptions): Promise<StartedRun>;
  /**
   * Signals a run's abort, best-effort (mvp spec §5.6). `false` means no run by that id is
   * executing here — a `running` row this process holds no controller for belongs to some other
   * one (a `path run` against the same `.path/path.db`, or an earlier crashed server), and its
   * caller must not report a cancel it cannot perform. Cancelling twice is a no-op that still
   * answers `true`, which is what makes a double click safe.
   */
  cancel(rootRunId: string): boolean;
  /**
   * Subscribes to a root run's event stream: the persisted narrative after `afterSeq` (all of it
   * when `undefined` — a fresh connect), then live events as they are published.
   *
   * `onEnd` fires when no more events will come: the run reached a terminal status, or it is not
   * executing here and has no live channel to join. Returns an unsubscribe for a caller that hangs
   * up first.
   *
   * The seam this replaces was the subtlest part of the SSE route. Subscribing happens *before* the
   * replay is read, so an event published mid-read is held rather than missed, and every delivered
   * `seq` is tracked so nothing replay already covered is sent twice.
   */
  stream(rootRunId: string, afterSeq: number | undefined, handlers: RunStreamHandlers): Unsubscribe;
  /**
   * How many runs are cancellable here — 0 once every started run has settled. A leaked entry is a
   * slow leak in a long-lived server; a missing one is a refused cancel of a live run.
   */
  readonly cancellable: number;
}

/** `Project.run`'s options, minus the audit seam and the extension points this module owns. */
export interface StartRunOptions {
  input?: { [key: string]: JsonValue };
  operatorConfig?: ConfigObject;
  /** The whole validated workflow tree, so nested `workflow` refs resolve without re-reading. */
  files: Map<string, WorkflowFile>;
  logBackends?: LogBackendId[];
  llmConcurrency?: number;
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
 * One `LiveRuns` per server process, over the process's one `Project` (#64) — runs execute
 * in-process (server-api-v0.md §0), which is what makes a live channel and an in-memory controller
 * the honest answers to "watch this run" and "stop this run".
 */
export function createLiveRuns(project: Project): LiveRuns {
  const hub = new RunEventHub();
  /**
   * The root runs executing here, each holding the `AbortController` whose signal went to
   * `runWorkflow`. Membership is this server's honest answer to "can I actually stop this run?",
   * which is why an id is filed only once `run-started` has produced it and dropped on every
   * outcome.
   */
  const controllers = new Map<string, AbortController>();

  return {
    async start(rootFile, workflowDir, options): Promise<StartedRun> {
      // Resolved as soon as the first `run-started` observation arrives — the async contract (§2):
      // the response goes out before the run finishes, not before it starts.
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

      const runPromise = project.run(rootFile, workflowDir, {
        ...options,
        // The live-forwarding backend rides alongside the configured db/NDJSON backends so
        // subscribers (§5) see every already-masked event in `seq` order — independent of which
        // backends the run persists to. It never throws, so it can't fail the run.
        extraBackends: [createLiveLogBackend(hub)],
        // Appended after persistence and logging by `Project.run`, which is the point: this is what
        // resolves `start`, and a caller may read the run the moment it does.
        extraObservers: [captureObserver],
        signal: controller.signal,
        warn: (message) => console.error(`warning: ${message}`),
      });

      // Fire-and-forget from the starter's point of view: the run keeps executing after `start`
      // resolves. Never left unhandled — a rejection here means `run-started` never fired either,
      // so it also settles `started` (a no-op if it already resolved).
      runPromise
        .then(
          (result) => {
            if (result.status === "failed") console.error(`run failed: ${result.error}`);
          },
          (err) => {
            started.reject(err);
            console.error(`run crashed: ${err instanceof Error ? err.stack : String(err)}`);
          },
        )
        // However it ended, the run is over. Tearing both registries down here rather than in each
        // arm is what makes "on every outcome" true by construction, so a long-lived server
        // accumulates neither.
        .finally(() => {
          if (registeredRootRunId === undefined) return; // never started; neither holds an entry
          controllers.delete(registeredRootRunId);
          // Normally already closed: the root run's terminal event drives the live backend's
          // `close`. This is the backstop for the one path that has no terminal event —
          // `runWorkflow` rejecting with a propagating bug rather than converting it to a failed
          // run (#74). Without it the channel outlives the run and every subscriber hangs open.
          // Idempotent, so the normal path is unaffected.
          hub.close(registeredRootRunId);
        });

      return started.promise;
    },

    cancel(rootRunId: string): boolean {
      const controller = controllers.get(rootRunId);
      if (!controller) return false;
      // Aborting an already-aborted run is a no-op that still answers `true` — a second cancel of a
      // still-unwinding run is not a refusal.
      controller.abort();
      return true;
    },

    stream(rootRunId: string, afterSeq: number | undefined, handlers: RunStreamHandlers): Unsubscribe {
      // The high-water mark of every seq already delivered, across replay and live — anything at or
      // below it is dropped, so nothing is sent twice regardless of when the first live event lands
      // relative to the read below.
      let lastSeq = afterSeq ?? 0;
      let live = false;
      const buffered: LogEvent[] = [];

      function deliver(event: LogEvent): void {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        handlers.onEvent(event);
      }

      // Subscribe *before* reading history: anything the hub publishes from here on is captured
      // (held in `buffered` until replay finishes) even if it lands mid-read, so nothing published
      // after this point is ever missed.
      const unsubscribe = hub.subscribe(
        rootRunId,
        (event) => (live ? deliver(event) : buffered.push(event)),
        handlers.onEnd,
      );

      for (const event of project.archive.tree(rootRunId)?.events(afterSeq) ?? []) deliver(event);
      for (const event of buffered) deliver(event);
      live = true;

      // No open channel: the run already reached a terminal status, isn't executing here, or never
      // existed. Whatever was replayed above is the whole story.
      if (unsubscribe === null) {
        handlers.onEnd();
        return () => {};
      }

      return unsubscribe;
    },

    get cancellable(): number {
      return controllers.size;
    },
  };
}
