import type { IncomingMessage, ServerResponse } from "node:http";
import { getRunsForRoot, readNdjsonLog } from "@path/engine";
import type { LogEvent } from "@path/schema";
import { sendError } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function writeFrame(res: ServerResponse, event: LogEvent): void {
  res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
}

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
 * The persisted replay slice for a reconnect: `readNdjsonLog`'s full narrative, filtered to
 * `seq >` `afterSeq` (or left whole, if `afterSeq` is `undefined` — a fresh connect replays from
 * seq 1). An empty `run.log` read (§5's known v0 limitation, or no events yet) just yields `[]`.
 */
function readReplayEvents(projectDir: string, rootRunId: string, afterSeq: number | undefined): LogEvent[] {
  const events = readNdjsonLog(projectDir, rootRunId);
  return afterSeq === undefined ? events : events.filter((event) => event.seq > afterSeq);
}

/**
 * `GET /v0/runs/:root_run_id/events` (server-api-v0.md §5): the SSE event stream, with standard
 * reconnect/replay semantics. Each frame carries `id: <seq>` + a `data:` line with the event
 * JSON-encoded verbatim (already snake_case). On connect: replay persisted history from `run.log`
 * (seq > `Last-Event-ID` if present, else full history from seq 1), then switch to live via the
 * root run's `RunEventHub` channel. The stream closes when the root run reaches a terminal status.
 */
export function handleGetRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  rootRunId: string,
): void {
  // Unknown root run → 404. A run row exists the moment `POST /v0/runs` returns (runStarted has
  // fired), so any id a client could hold is already queryable here.
  if (getRunsForRoot(ctx.project.db, rootRunId).length === 0) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  const afterSeq = parseLastEventId(req);

  // The high-water mark of every seq already written to this response, across replay and live —
  // `deliver` drops anything at or below it, so nothing is ever sent twice regardless of exactly
  // when the hub's first live event lands relative to the historical read below.
  let lastSeq = afterSeq ?? 0;
  let live = false;
  const buffered: LogEvent[] = [];

  function deliver(event: LogEvent): void {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    writeFrame(res, event);
  }

  // Subscribe *before* reading history: any event the hub publishes from here on is captured (held
  // in `buffered` until replay finishes) even if it lands mid-read, so nothing published after this
  // point is ever missed — `deliver`'s seq guard drops anything replay already covered.
  const unsubscribe = ctx.hub.subscribe(
    rootRunId,
    (event) => (live ? deliver(event) : buffered.push(event)),
    () => res.end(),
  );

  res.writeHead(200, SSE_HEADERS);

  for (const event of readReplayEvents(ctx.project.dir, rootRunId, afterSeq)) deliver(event);
  for (const event of buffered) deliver(event);
  live = true;

  // No open channel: the run already reached a terminal status. Replay above (if any) is the whole
  // story — end the stream immediately.
  if (unsubscribe === null) {
    res.end();
    return;
  }

  // Client hung up before the run finished — detach so the hub stops forwarding to a dead socket.
  req.on("close", unsubscribe);
}
