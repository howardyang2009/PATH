import type { PathApiClient } from "./api-client.js";
import { subscribeRunEvents, type RunEventSubscription } from "./sse-client.js";
import { RunViewModel } from "./view-model.js";

/**
 * End-to-end wiring for one root run (the view-model bullet of the ticket): hydrate the tree from
 * `GET /v0/runs/:root_run_id`, then fold the live SSE narrative into the same `RunViewModel`. The
 * initial `GET` gives the seq high-water mark, so the event subscription resumes from it with
 * `Last-Event-ID` — no gap, no duplicate with what the snapshot already carried. Returns the model
 * (subscribe for updates) and a `close` that tears down the stream.
 */
export interface ConnectedRun {
  model: RunViewModel;
  close(): void;
}

export interface ConnectRunOptions {
  client: PathApiClient;
  rootRunId: string;
  onError?: (error: unknown) => void;
  onClose?: () => void;
  /** Poll cadence while the run is parked `awaiting` (forwarded to the SSE client; default 3000ms). */
  idlePollMs?: number;
  /** Base reconnect backoff after a drop (forwarded to the SSE client; default 200ms). */
  reconnectDelayMs?: number;
}

export async function connectRunViewModel(options: ConnectRunOptions): Promise<ConnectedRun> {
  const { client, rootRunId } = options;
  const model = new RunViewModel(rootRunId);

  const tree = await client.getRun(rootRunId);
  model.hydrate(tree);

  const lastSeq = model.getState().narrative.at(-1)?.seq;

  let closed = false;
  const rehydrate = createRehydrator(client, rootRunId, model, () => closed, options.onError);

  // While the run is quiescent (`waiting`), each slow poll re-opens the stream for an instant. Without
  // this flag that `onOpen` would flip the indicator back to `live` on every poll, so the pane flickers
  // `waiting → live → waiting`. Hold `waiting` until a real event arrives, which is the honest signal
  // the run has resumed.
  let quiescent = false;

  const subscription: RunEventSubscription = subscribeRunEvents({
    baseUrl: client.baseUrl,
    rootRunId,
    lastEventId: lastSeq,
    idlePollMs: options.idlePollMs,
    reconnectDelayMs: options.reconnectDelayMs,
    onEvent: (event) => {
      // A log event names only the run it happened in — the envelope carries no `parent_run_id`
      // (mvp spec §8.1). So the first event of a child run started after the last tree read would
      // otherwise leave that run parentless, flattening the tree exactly while it is being watched.
      // Re-read the tree to learn where it hangs; `GET /v0/runs/:root_run_id` is the only source of
      // run structure.
      if (quiescent) {
        quiescent = false;
        model.setStreamPhase("live");
      }
      const isNewRun = !model.getState().runs.has(event.run_id);
      model.applyEvent(event);
      if (isNewRun) rehydrate();
    },
    // Stream liveness is state a viewer renders (a "live · SSE" vs "reconnecting" indicator), so it
    // lands in the view-model snapshot rather than only in these callbacks — issue #48.
    onOpen: () => {
      if (!quiescent) model.setStreamPhase("live");
    },
    // A parked leaf ends the stream cleanly (ADR 0038); the core polls for the continuation, so this is
    // a calm "waiting", not the alarm of a dropped connection.
    onWaiting: () => {
      quiescent = true;
      model.setStreamPhase("waiting");
    },
    onReconnecting: () => {
      quiescent = false;
      model.setStreamPhase("reconnecting");
    },
    onError: (error) => {
      model.setStreamPhase("failed");
      options.onError?.(error);
    },
    onClose: () => {
      model.setStreamPhase("closed");
      options.onClose?.();
    },
    fetch: client.fetch,
  });

  return {
    model,
    close(): void {
      if (closed) return;
      closed = true;
      subscription.close();
    },
  };
}

/**
 * A coalescing tree re-read. Bursts of new runs (a parallel block starting) must not turn into a
 * burst of `GET`s, so one request is in flight at a time and any calls made during it collapse into
 * a single follow-up read. A failed re-read is reported but never fatal: the stream stays live and
 * the next new run tries again.
 */
function createRehydrator(
  client: PathApiClient,
  rootRunId: string,
  model: RunViewModel,
  isClosed: () => boolean,
  onError?: (error: unknown) => void,
): () => void {
  let inFlight = false;
  let queued = false;

  const read = (): void => {
    inFlight = true;
    client
      .getRun(rootRunId)
      .then((tree) => {
        if (!isClosed()) model.hydrate(tree);
      })
      .catch((error: unknown) => onError?.(error))
      .finally(() => {
        inFlight = false;
        if (queued && !isClosed()) {
          queued = false;
          read();
        }
      });
  };

  return () => {
    if (isClosed()) return;
    if (inFlight) queued = true;
    else read();
  };
}
