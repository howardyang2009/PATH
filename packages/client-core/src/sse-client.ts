import type { LogEvent } from "@path/schema";
import { defaultFetch, type FetchLike } from "./api-client.js";

/**
 * A pure-TS SSE client for `GET /v0/runs/:root_run_id/events` (server-api-v0.md §5). No DOM, so no
 * `EventSource`: it reads the `fetch` response body as a stream and parses the `id:`/`data:` frames
 * itself. `data:` is one `LogEvent` JSON verbatim (already snake_case at the envelope level).
 *
 * Reconnect/replay is the standard SSE mechanism the server already implements: each frame's `id:`
 * is the event `seq`, and on reconnect the client sends `Last-Event-ID: <last seq>` so the server
 * replays `seq >` that value out of `run.log`, then switches to live — no gap, no duplicate. This
 * client tracks the high-water seq and, if the transport drops before the run is done, reconnects
 * from it automatically. It stops reconnecting once the root run reaches a terminal status (the
 * root implicit step's `step-finished`, `node_id: null`), which is also when the server closes the
 * stream for good.
 */

export interface SubscribeRunEventsOptions {
  /** Base URL of the running server, e.g. `http://localhost:8080`. Trailing slash trimmed. */
  baseUrl: string;
  rootRunId: string;
  /** Called for each event in `seq` order, across any reconnects. */
  onEvent: (event: LogEvent) => void;
  /** The stream is connected and delivering — fired on the first connect and on every reconnect. */
  onOpen?: () => void;
  /**
   * The stream dropped mid-run and a reconnect from the high-water `seq` is about to be attempted.
   * Not an error: it is the liveness signal a viewer shows as "reconnecting" (issue #48). Never
   * fired when `reconnect` is off — there the drop ends the subscription through `onError`.
   */
  onReconnecting?: (error?: unknown) => void;
  /** Terminal completion — the root run finished and the stream closed for good. */
  onClose?: () => void;
  /** A transport/parse error that ended the subscription (only when reconnect is off/exhausted). */
  onError?: (error: unknown) => void;
  /** Resume from a known seq on the first connect (default: full history from seq 1). */
  lastEventId?: number;
  /** Reconnect from the last seq when the transport drops mid-run (default true). */
  reconnect?: boolean;
  /** Injected `fetch`; defaults to the global. */
  fetch?: FetchLike;
}

export interface RunEventSubscription {
  /** Stop the subscription and abort any in-flight request. Idempotent. */
  close(): void;
}

/** The root implicit step finishing (`node_id: null`) marks the whole root run terminal (§5). */
function isRootTerminal(event: LogEvent): boolean {
  return event.type === "step-finished" && event.node_id === null;
}

export function subscribeRunEvents(options: SubscribeRunEventsOptions): RunEventSubscription {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? defaultFetch;
  const reconnect = options.reconnect ?? true;

  let lastSeq = options.lastEventId;
  let terminalSeen = false;
  let closed = false;
  const controller = new AbortController();

  const deliver = (event: LogEvent): void => {
    lastSeq = event.seq;
    if (isRootTerminal(event)) terminalSeen = true;
    options.onEvent(event);
  };

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        const res = await openStream(doFetch, baseUrl, options.rootRunId, lastSeq, controller.signal);
        if (!res.ok || !res.body) {
          throw new Error(`event stream request failed with status ${res.status}`);
        }
        options.onOpen?.();
        await readFrames(res, deliver, () => closed);
      } catch (error) {
        if (closed) return;
        // Transport dropped — reconnect from the high-water seq (server replays the tail), unless
        // reconnect is disabled, in which case the error ends the subscription.
        if (reconnect) {
          options.onReconnecting?.(error);
          continue;
        }
        options.onError?.(error);
        return;
      }
      // The stream ended. A terminal event means the run finished and the server closed for good —
      // a clean completion. Ending without a terminal event is an early close (e.g. proxy timeout):
      // reconnect and catch up when enabled.
      if (closed) return;
      if (terminalSeen) {
        options.onClose?.();
        return;
      }
      // With reconnect off there is nothing left to try, and this is *not* a completion: reporting it
      // as one would tell a viewer the run is done while the rest of the narrative never arrives.
      if (!reconnect) {
        options.onError?.(new Error("event stream ended before the root run finished"));
        return;
      }
      options.onReconnecting?.();
    }
  };

  void run();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}

function openStream(
  doFetch: FetchLike,
  baseUrl: string,
  rootRunId: string,
  lastEventId: number | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId);
  return doFetch(`${baseUrl}/v0/runs/${encodeURIComponent(rootRunId)}/events`, { headers, signal });
}

/**
 * Reads SSE frames off a response body, decoding each `data:` line into a `LogEvent` and handing it
 * to `onEvent`. Returns when the stream ends (server closed it) or `isClosed()` becomes true; the
 * caller re-checks `closed` to tell the two apart. Frame boundary is the blank line (`\n\n`), per
 * the SSE grammar.
 */
async function readFrames(
  res: Response,
  onEvent: (event: LogEvent) => void,
  isClosed: () => boolean,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (isClosed()) {
      await reader.cancel().catch(() => {});
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (dataLine) {
        const json = dataLine.slice(dataLine.indexOf(":") + 1).trimStart();
        onEvent(JSON.parse(json) as LogEvent);
      }
    }
  }
}
