import type { LogEvent } from "@path/schema";

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

  /** The root run reached a terminal status — notify subscribers (end-of-stream) and drop the channel. */
  close(rootRunId: string): void {
    const channel = this.channels.get(rootRunId);
    if (!channel) return;
    this.channels.delete(rootRunId);
    for (const listener of channel.closeListeners) listener();
  }

  /** Attach a live subscriber; returns an unsubscribe function, or `null` if there is no open channel. */
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
