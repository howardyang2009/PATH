import type { IncomingMessage } from "node:http";
import { encodeEventFrame } from "@path/schema";
import { sendError } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/** The `Last-Event-ID` seq to replay after (server-api-v0.md §5); absent or non-numeric replays all. */
function parseLastEventId(req: IncomingMessage): number | undefined {
  const header = req.headers["last-event-id"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * `GET /v0/runs/:root_run_id/events` (server-api-v0.md §5): the SSE event stream. Which events a
 * subscriber gets, and in what order, is `LiveRuns.stream`'s guarantee; this route owns the 404, the
 * `Last-Event-ID` header, and the socket.
 */
export function handleGetRunEvents({
  req,
  res,
  ctx,
  params: [rootRunId],
}: ApiRequest<[string]>): void {
  // Unknown root run → 404. A run row exists the moment `POST /v0/runs` returns.
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
