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
  const subscription: RunEventSubscription = subscribeRunEvents({
    baseUrl: client.baseUrl,
    rootRunId,
    lastEventId: lastSeq,
    onEvent: (event) => model.applyEvent(event),
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
