import type { LogEvent } from "./log-event.js";

/** The v0 event stream's wire framing (server-api-v0.md §5): `id: <seq>`, `data: <event JSON>`, blank
 * line. `seq` doubles as the SSE event id, which makes `Last-Event-ID` reconnects exact. */

/** One decoded frame: the event, and the `id:` it arrived under. */
export interface EventFrame {
  /** The `id:` line verbatim — what a reconnect sends back as `Last-Event-ID`; absent if omitted. */
  id: string | undefined;
  event: LogEvent;
}

/** Encodes one event as an SSE frame, `id:` first, terminated by the blank line. */
export function encodeEventFrame(event: LogEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Request headers for `GET /v0/runs/:root_run_id/events` (§5): omitting `lastEventId` asks for full history, else a
 * replay of `seq >` it.
 */
export function eventStreamHeaders(lastEventId?: number): Record<string, string> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId);
  return headers;
}

export interface EventFrameDecoder {
  /**
   * Feeds one chunk, returning the frames it completed in order; a chunk ending mid-frame is held until the rest
   * arrives.
   */
  push(chunk: string): EventFrame[];
}

/** A frame decoder over one connection's decoded text — text, not bytes, so a caller keeps its own
 * transport and `TextDecoder`. The event JSON is not re-validated: the engine did so at write time. */
export function createEventFrameDecoder(): EventFrameDecoder {
  let buffer = "";

  return {
    push(chunk: string): EventFrame[] {
      buffer += chunk;
      const frames: EventFrame[] = [];

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");

        const lines = block.split("\n");
        const dataLine = lines.find((line) => line.startsWith("data:"));
        // A frame with no `data:` is not an event — SSE comments and keep-alives look like this.
        if (dataLine === undefined) continue;

        const idLine = lines.find((line) => line.startsWith("id:"));
        frames.push({
          id: idLine === undefined ? undefined : fieldValue(idLine),
          event: JSON.parse(fieldValue(dataLine)) as LogEvent,
        });
      }

      return frames;
    },
  };
}

/** An SSE field's value: after the colon, one optional leading space stripped (the grammar allows both forms). */
function fieldValue(line: string): string {
  const value = line.slice(line.indexOf(":") + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
}
