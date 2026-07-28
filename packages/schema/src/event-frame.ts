import type { LogEvent } from "./log-event.js";

/**
 * The v0 event stream's wire framing (server-api-v0.md §5): how a `LogEvent` becomes bytes on an
 * SSE connection, and how it comes back.
 *
 * **Why this lives here.** The same reason the v0 run-record shapes do (`wire-v0.ts`): the framing
 * was written four times — encoded by the server's SSE route, decoded by `@path/client-core`,
 * decoded again by the server's own acceptance driver (which cannot import client-core), and twice
 * more in the server's tests. The copies had already drifted: one accepted `data:` with or without
 * the space, the others assumed the space and sliced a fixed six characters, so a server that ever
 * emitted the compact form would have been read by one client and silently ignored by the rest.
 * Nothing connected the encoder to any decoder, so no type error could have caught it.
 *
 * The frame grammar is small and fixed: `id: <seq>`, `data: <event JSON>`, blank line. `seq` is
 * monotonic per root run and doubles as the SSE event id, which is what makes `Last-Event-ID`
 * reconnects exact.
 */

/** One decoded frame: the event, and the `id:` it arrived under. */
export interface EventFrame {
  /**
   * The frame's `id:` line verbatim — the event's `seq` as it crossed the wire, which is what a
   * reconnect sends back as `Last-Event-ID`. `undefined` only if the peer omitted the line; the
   * PATH server always writes it.
   */
  id: string | undefined;
  event: LogEvent;
}

/** Encodes one event as an SSE frame, `id:` first, terminated by the blank line. */
export function encodeEventFrame(event: LogEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The request headers for `GET /v0/runs/:root_run_id/events` (§5). Omitting `lastEventId` asks for
 * the full history from seq 1; passing one asks the server to replay `seq >` it, then go live.
 */
export function eventStreamHeaders(lastEventId?: number): Record<string, string> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId);
  return headers;
}

export interface EventFrameDecoder {
  /**
   * Feeds one chunk of the stream and returns the frames it completed, in order. A chunk that ends
   * mid-frame contributes nothing until the rest arrives — the decoder holds the remainder, so a
   * caller may push arbitrary transport-sized pieces.
   */
  push(chunk: string): EventFrame[];
}

/**
 * A frame decoder over the decoded text of one connection. Text, not bytes: a caller already owns
 * its transport (a `fetch` body reader, a socket) and its `TextDecoder`, and keeping those out
 * leaves this usable from a browser, a Node test, and the acceptance driver alike.
 *
 * The event JSON is not re-validated. The engine validates every event against `LogEventSchema`
 * before a backend writes it, so a client that parsed the same bytes again could only reject what
 * the server already vouched for — and would do it in the middle of a live stream.
 */
export function createEventFrameDecoder(): EventFrameDecoder {
  let buffer = "";

  return {
    push(chunk: string): EventFrame[] {
      buffer += chunk;
      const frames: EventFrame[] = [];

      let separator: number;
      // The frame boundary is the blank line, per the SSE grammar.
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

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

/**
 * An SSE field's value: everything after the colon, with one optional leading space stripped (the
 * grammar allows `data:x` and `data: x` to mean the same thing — the drift between the four hand
 * written copies of this).
 */
function fieldValue(line: string): string {
  const value = line.slice(line.indexOf(":") + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
}
