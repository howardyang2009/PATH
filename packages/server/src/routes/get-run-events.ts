import type { IncomingMessage, ServerResponse } from "node:http";
import { encodeEventFrame } from "@path/schema";
import { sendError } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * Parses the `Last-Event-ID` request header (server-api-v0.md §5) into the seq to replay after —
 * `undefined` if absent or not a plain non-negative integer, which replays the same as a fresh
 * connect (full history from seq 1).
 */
function parseLastEventId(req: IncomingMessage): number | undefined {
  const header = req.headers["last-event-id"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * `GET /v0/runs/:root_run_id/events` (server-api-v0.md §5): the SSE event stream, with standard
 * reconnect/replay semantics. Which events a subscriber gets, and in what order, is
 * `LiveRuns.stream`'s guarantee; the frame grammar is `encodeEventFrame`'s. What this route owns is
 * the 404, the `Last-Event-ID` header, and the socket.
 */
export function handleGetRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  rootRunId: string,
): void {
  // Unknown root run → 404. A run row exists the moment `POST /v0/runs` returns (run-started has
  // fired), so any id a client could hold is already queryable here.
  if (!ctx.project.archive.tree(rootRunId)) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  res.writeHead(200, SSE_HEADERS);

  const unsubscribe = ctx.live.stream(rootRunId, parseLastEventId(req), {
    onEvent: (event) => res.write(encodeEventFrame(event)),
    onEnd: () => res.end(),
  });

  // Client hung up before the run finished — detach so nothing forwards to a dead socket.
  req.on("close", unsubscribe);
}
