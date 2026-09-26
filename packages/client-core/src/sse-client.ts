import { createEventFrameDecoder, eventStreamHeaders, type LogEvent } from "@path/schema";
import { defaultFetch, type FetchLike } from "./api-client.js";
import { isRootRunFinished } from "./event-outcome.js";

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
  /**
   * The run is quiescent: a leaf is parked `awaiting`, so the server ended the stream with no more
   * events to send although the root run is still `running` (ADR 0038). This is **not** a drop — the
   * core slow-polls (`idlePollMs`) for a `complete` driven elsewhere rather than hot-looping — so a
   * viewer shows a calm "waiting" note here, distinct from `onReconnecting`. Fired before each poll.
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
  /**
   * The base delay before a reconnect after a drop or an early mid-run close (default 200ms). Doubles
   * per consecutive failure up to {@link MAX_RECONNECT_MS}, and resets on a healthy open — the backoff
   * that keeps a flaky or slow server from being hammered.
   */
  reconnectDelayMs?: number;
  /**
   * How long to wait between polls while the run is quiescent (`awaiting`), default 3000ms. Longer
   * than the reconnect delay: nothing is wrong, the poll only exists to catch a `complete` a different
   * operator drove, so a status settling a few seconds late costs nothing.
   */
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
  // The runs currently parked `awaiting`: a `step-awaiting` adds one, its later `step-finished` (the
  // `complete`) clears it. Non-empty at a clean stream end means the run is quiescent, not dropped —
  // the server simply has nothing more to send until a completion. Kept across reconnects (the server
  // replays only `seq >` the high-water mark, so a parked leaf's `step-awaiting` is not re-delivered).
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
        // Transport dropped — reconnect from the high-water seq (server replays the tail), unless
        // reconnect is disabled, in which case the error ends the subscription.
        if (reconnect) {
          options.onReconnecting?.(error);
          await delay(backoff, controller.signal);
          backoff = Math.min(backoff * 2, MAX_RECONNECT_MS);
          continue;
        }
        options.onError?.(error);
        return;
      }
      // The stream ended. A terminal event means the run finished and the server closed for good —
      // a clean completion.
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
      if (awaitingRuns.size > 0) {
        // Quiescent: a leaf is parked `awaiting`, so this clean end is expected, not a drop (ADR 0038).
        // Slow-poll for a `complete` driven elsewhere instead of hot-looping a reconnect.
        options.onWaiting?.();
        await delay(idlePollMs, controller.signal);
        continue;
      }
      // A clean end mid-run with nothing parked is an early close (e.g. a proxy idle-timeout): reconnect
      // and catch up, with the same backoff a dropped transport uses.
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

/**
 * Reads a response body to its end, handing each decoded event to `onEvent`. Returns when the
 * stream ends (server closed it) or `isClosed()` becomes true; the caller re-checks `closed` to
 * tell the two apart. The frame grammar itself is `@path/schema`'s — this owns only the transport.
 */
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
