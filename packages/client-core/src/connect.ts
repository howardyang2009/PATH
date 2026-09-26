import type { PathApiClient } from "./api-client.js";
import { type RunEventSubscription, subscribeRunEvents } from "./sse-client.js";
import { RunViewModel } from "./view-model.js";

/** End-to-end wiring for one root run: hydrate the tree from `GET /v0/runs/:root_run_id`, then fold the live SSE
 * narrative into the same `RunViewModel`, resuming from the snapshot's seq high-water mark.
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

  // While the run is quiescent (`waiting`), each slow poll re-opens the stream for an instant; without
  // this flag that `onOpen` would flip the indicator `waiting → live → waiting` on every poll.
  let quiescent = false;

  const subscription: RunEventSubscription = subscribeRunEvents({
    baseUrl: client.baseUrl,
    rootRunId,
    lastEventId: lastSeq,
    idlePollMs: options.idlePollMs,
    reconnectDelayMs: options.reconnectDelayMs,
    onEvent: (event) => {
      // A log event carries no `parent_run_id` (mvp spec §8.1), so a child run started after the last
      // tree read would stay parentless. Re-read the tree — the only source of run structure.
      if (quiescent) {
        quiescent = false;
        model.setStreamPhase("live");
      }
      const isNewRun = !model.getState().runs.has(event.run_id);
      model.applyEvent(event);
      if (isNewRun) rehydrate();
    },
    // Stream liveness is state a viewer renders, so it lands in the view-model snapshot, not only here.
    onOpen: () => {
      if (!quiescent) model.setStreamPhase("live");
    },
    // A parked leaf ends the stream cleanly (ADR 0038), so this is a calm "waiting", not a drop.
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

/** A coalescing tree re-read: one request in flight at a time, calls made during it collapsing into a single
 * follow-up. A failed re-read is reported but never fatal.
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
