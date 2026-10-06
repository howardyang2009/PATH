import type { LogEvent } from "@path/schema";
import type { RunStreamHandlers, Unsubscribe } from "./live-runs.js";

type EventListener = (event: LogEvent) => void;
type CloseListener = () => void;

interface Channel {
  listeners: Set<EventListener>;
  closeListeners: Set<CloseListener>;
}

/**
 * Live fan-out from a run's log stream to its SSE clients (§5): one channel per in-flight root run.
 */
export class RunEventHub {
  private readonly channels = new Map<string, Channel>();

  /** A root run's live stream begins — register its channel so clients can subscribe. */
  open(rootRunId: string): void {
    if (!this.channels.has(rootRunId)) {
      this.channels.set(rootRunId, { listeners: new Set(), closeListeners: new Set() });
    }
  }

  /** Fan one already-assembled, already-masked event out to every subscriber of this run. */
  publish(rootRunId: string, event: LogEvent): void {
    const channel = this.channels.get(rootRunId);
    if (!channel) return;
    for (const listener of channel.listeners) listener(event);
  }

  /** The root run reached a terminal status — notify subscribers (end-of-stream) and drop the
   * channel. */
  close(rootRunId: string): void {
    const channel = this.channels.get(rootRunId);
    if (!channel) return;
    this.channels.delete(rootRunId);
    for (const listener of channel.closeListeners) listener();
  }

  /** Attach a live subscriber; returns an unsubscribe function, or `null` if there is no open
   * channel. */
  subscribe(
    rootRunId: string,
    onEvent: EventListener,
    onClose: CloseListener,
  ): (() => void) | null {
    const channel = this.channels.get(rootRunId);
    if (!channel) return null;
    channel.listeners.add(onEvent);
    channel.closeListeners.add(onClose);
    return () => {
      channel.listeners.delete(onEvent);
      channel.closeListeners.delete(onClose);
    };
  }
}

/**
 * Subscribes to a root run's stream: the `history` after `afterSeq`, then live events from `hub`.
 * The subscription precedes the replay read and every delivered `seq` is tracked, so nothing is
 * missed or sent twice.
 */
export function streamRun(
  hub: RunEventHub,
  history: (afterSeq: number | undefined) => LogEvent[],
  rootRunId: string,
  afterSeq: number | undefined,
  handlers: RunStreamHandlers,
): Unsubscribe {
  let lastSeq = afterSeq ?? 0;
  let live = false;
  const buffered: LogEvent[] = [];

  function deliver(event: LogEvent): void {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    handlers.onEvent(event);
  }

  // Subscribe *before* reading history: a publish landing mid-read is buffered.
  const unsubscribe = hub.subscribe(
    rootRunId,
    (event) => (live ? deliver(event) : buffered.push(event)),
    handlers.onEnd,
  );

  for (const event of history(afterSeq)) deliver(event);
  for (const event of buffered) deliver(event);
  live = true;

  // No open channel: the run is terminal, not executing here, or never existed.
  if (unsubscribe === null) {
    handlers.onEnd();
    return () => {};
  }
  return unsubscribe;
}
