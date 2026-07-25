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
}

export async function connectRunViewModel(options: ConnectRunOptions): Promise<ConnectedRun> {
  const { client, rootRunId } = options;
  const model = new RunViewModel(rootRunId);

  const tree = await client.getRun(rootRunId);
  model.hydrate(tree);

  const lastSeq = model.getState().narrative.at(-1)?.seq;

  let closed = false;
  const rehydrate = createRehydrator(client, rootRunId, model, () => closed, options.onError);

  const subscription: RunEventSubscription = subscribeRunEvents({
    baseUrl: client.baseUrl,
    rootRunId,
    lastEventId: lastSeq,
    onEvent: (event) => {
      // A log event names only the run it happened in — the envelope carries no `parent_run_id`
      // (mvp spec §8.1). So the first event of a child run started after the last tree read would
      // otherwise leave that run parentless, flattening the tree exactly while it is being watched.
      // Re-read the tree to learn where it hangs; `GET /v0/runs/:root_run_id` is the only source of
      // run structure.
      const isNewRun = !model.getState().runs.has(event.run_id);
      model.applyEvent(event);
      if (isNewRun) rehydrate();
    },
    onError: options.onError,
    onClose: options.onClose,
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
