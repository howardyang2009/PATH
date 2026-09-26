import { createEventFrameDecoder, eventStreamHeaders, type LogEvent } from "@path/schema";
import { defaultFetch, type FetchLike } from "./api-client.js";
import { isRootRunFinished } from "./event-outcome.js";

/** Pure-TS SSE client for `GET /v0/runs/:root_run_id/events` (server-api-v0.md §5). No DOM, so no
 * `EventSource`: it reads the `fetch` body as a stream and parses `id:`/`data:` frames itself, each
 * `data:` one `LogEvent` JSON. A mid-run drop reconnects with `Last-Event-ID: <seq>`.
 */

export interface SubscribeRunEventsOptions {
  /** Base URL of the running server, e.g. `http://localhost:8080`. Trailing slash trimmed. */
  baseUrl: string;
  rootRunId: string;
  /** Called for each event in `seq` order, across any reconnects. */
  onEvent: (event: LogEvent) => void;
  /** The stream is connected and delivering — fired on the first connect and on every reconnect. */
  onOpen?: () => void;
  /** The stream dropped mid-run and a reconnect from the high-water `seq` is about to be attempted. */
  onReconnecting?: (error?: unknown) => void;
  /** The run is quiescent: a leaf is parked `awaiting`, so the server ended the stream with no more
   * events although the root run is still `running` (ADR 0038) — the core slow-polls. Fired per poll.
   */
  onWaiting?: () => void;
  /** Terminal completion — the root run finished and the stream closed for good. */
  onClose?: () => void;
  /** A transport/parse error that ended the subscription (only when reconnect is off/exhausted). */
  onError?: (error: unknown) => void;
  /** Resume from a known seq on the first connect (default: full history from seq 1). */
  lastEventId?: number;
  /** Reconnect from the last seq when the transport drops mid-run (default true). */
  reconnect?: boolean;
  /** Base reconnect delay before a drop retry (default 200ms); doubles per failure up to {@link MAX_RECONNECT_MS}. */
  reconnectDelayMs?: number;
  /** Poll interval while the run is quiescent (default 3000ms); nothing is wrong, so it waits longer. */
  idlePollMs?: number;
  /** Injected `fetch`; defaults to the global. */
  fetch?: FetchLike;
}

/** The reconnect backoff ceiling — a drop never waits longer than this between attempts. */
const MAX_RECONNECT_MS = 5000;
const DEFAULT_RECONNECT_MS = 200;
const DEFAULT_IDLE_POLL_MS = 3000;

/** A cancellable delay: resolves after `ms`, or at once when `signal` aborts (a `close()` mid-wait). */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface RunEventSubscription {
  /** Stop the subscription and abort any in-flight request. Idempotent. */
  close(): void;
}

export function subscribeRunEvents(options: SubscribeRunEventsOptions): RunEventSubscription {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? defaultFetch;
  const reconnect = options.reconnect ?? true;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;

  let lastSeq = options.lastEventId;
  let terminalSeen = false;
  let closed = false;
  let backoff = reconnectDelayMs;
  // Runs parked `awaiting`, kept across reconnects (the server replays only `seq >` the high-water mark).
  const awaitingRuns = new Set<string>();
  const controller = new AbortController();

  const deliver = (event: LogEvent): void => {
    lastSeq = event.seq;
    if (event.type === "step-awaiting") awaitingRuns.add(event.run_id);
    else if (event.type === "step-finished") awaitingRuns.delete(event.run_id);
    if (isRootRunFinished(event, options.rootRunId)) terminalSeen = true;
    options.onEvent(event);
  };

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        const res = await openStream(
          doFetch,
          baseUrl,
          options.rootRunId,
          lastSeq,
          controller.signal,
        );
        if (!res.ok || !res.body) {
          throw new Error(`event stream request failed with status ${res.status}`);
        }
        backoff = reconnectDelayMs; // a healthy open resets the backoff
        options.onOpen?.();
        await readFrames(res, deliver, () => closed);
      } catch (error) {
        if (closed) return;
        // Transport dropped — reconnect from the high-water seq (server replays the tail) when enabled.
        if (reconnect) {
          options.onReconnecting?.(error);
          await delay(backoff, controller.signal);
          backoff = Math.min(backoff * 2, MAX_RECONNECT_MS);
          continue;
        }
        options.onError?.(error);
        return;
      }
      // The stream ended: a terminal event means the run finished and the server closed for good.
      if (closed) return;
      if (terminalSeen) {
        options.onClose?.();
        return;
      }
      // With reconnect off this is not a completion — reporting one would say the run is done early.
      if (!reconnect) {
        options.onError?.(new Error("event stream ended before the root run finished"));
        return;
      }
      if (awaitingRuns.size > 0) {
        // Quiescent clean end (ADR 0038): slow-poll for a `complete` driven elsewhere, not a hot loop.
        options.onWaiting?.();
        await delay(idlePollMs, controller.signal);
        continue;
      }
      // A clean mid-run end with nothing parked is an early close (e.g. a proxy idle-timeout): reconnect.
      options.onReconnecting?.();
      await delay(backoff, controller.signal);
      backoff = Math.min(backoff * 2, MAX_RECONNECT_MS);
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
  return doFetch(`${baseUrl}/v0/runs/${encodeURIComponent(rootRunId)}/events`, {
    headers: eventStreamHeaders(lastEventId),
    signal,
  });
}

/** Read a response body to its end, handing each decoded event to `onEvent`; returns when the stream
 * ends or `isClosed()`. The frame grammar is `@path/schema`'s — this owns only the transport. */
async function readFrames(
  res: Response,
  onEvent: (event: LogEvent) => void,
  isClosed: () => boolean,
): Promise<void> {
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  const frames = createEventFrameDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (isClosed()) {
      await reader.cancel().catch(() => {});
      return;
    }
    for (const frame of frames.push(text.decode(value, { stream: true }))) onEvent(frame.event);
  }
}
