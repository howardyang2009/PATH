import type { IncomingMessage, ServerResponse } from "node:http";
import { getRunsForRoot, type LogEvent } from "@path/engine";
import { sendError } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * `GET /v0/runs/:root_run_id/events` (server-api-v0.md §5): the live SSE stream. Attaches to the
 * root run's in-process `RunEventHub` channel and writes each `LogEvent` as one SSE frame —
 * `id: <seq>` + a `data:` line carrying the event JSON-encoded verbatim (already snake_case). The
 * stream closes when the root run reaches a terminal status.
 *
 * Reconnect/replay (`Last-Event-ID`, NDJSON history) is out of scope for this endpoint — see #38;
 * a connection sees only events from connect time onward.
 */
export function handleGetRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  rootRunId: string,
): void {
  // Unknown root run → 404. A run row exists the moment `POST /v0/runs` returns (runStarted has
  // fired), so any id a client could hold is already queryable here.
  if (getRunsForRoot(ctx.db, rootRunId).length === 0) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  const unsubscribe = ctx.hub.subscribe(
    rootRunId,
    (event: LogEvent) => {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    () => res.end(),
  );

  res.writeHead(200, SSE_HEADERS);

  // No open channel: the run row exists but has already reached a terminal status, so there are no
  // live events to forward (replay is #38). The SSE headers are out; end the stream immediately.
  if (unsubscribe === null) {
    res.end();
    return;
  }

  // Client hung up before the run finished — detach so the hub stops forwarding to a dead socket.
  req.on("close", unsubscribe);
}
