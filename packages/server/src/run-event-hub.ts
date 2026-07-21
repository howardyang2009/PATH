import type { LogEvent } from "@path/engine";

type EventListener = (event: LogEvent) => void;
type CloseListener = () => void;

interface Channel {
  listeners: Set<EventListener>;
  closeListeners: Set<CloseListener>;
}

/**
 * The in-process fan-out from a run's live log stream to its connected SSE clients
 * (server-api-v0.md §5). Since execution is in-process, one `RunEventHub` per server holds an open
 * **channel** per in-flight root run: the run's live-forwarding `LogBackend` (see
 * `createLiveLogBackend`) drives `open`/`publish`/`close`, and each `GET /events` request
 * `subscribe`s to the matching channel.
 *
 * Live-only: a channel exists solely while its run executes, so `subscribe` returns `null` once the
 * run has finished (its channel closed) — the SSE handler then falls back to the db to tell an
 * already-finished run (end-of-stream) from an unknown one (404). Replay of past events is a
 * separate concern (#38), not this hub's.
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

  /** The root run reached a terminal status — notify subscribers (end-of-stream) and drop the channel. */
  close(rootRunId: string): void {
    const channel = this.channels.get(rootRunId);
    if (!channel) return;
    this.channels.delete(rootRunId);
    for (const listener of channel.closeListeners) listener();
  }

  /**
   * Attach a live subscriber to a run's channel. Returns an unsubscribe function, or `null` if the
   * run has no open channel (already finished, or never started) — the caller distinguishes those
   * two cases via the run store.
   */
  subscribe(rootRunId: string, onEvent: EventListener, onClose: CloseListener): (() => void) | null {
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
