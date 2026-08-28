import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import type { LogEvent } from "@path/schema";
import { subscribeRunEvents } from "../src/sse-client.js";

const EVENTS: LogEvent[] = [
  { type: "step-started", seq: 1, ts: "t1", run_id: "root", node_id: null, node_name: null, step_type: "workflow", worker_name: "spawn" },
  { type: "step-started", seq: 2, ts: "t2", run_id: "child", node_id: "draft", node_name: "draft", step_type: "prompt", worker_name: "sdk" },
  { type: "step-finished", seq: 3, ts: "t3", run_id: "child", node_id: "draft", node_name: "draft", status: "succeeded" },
  { type: "step-finished", seq: 4, ts: "t4", run_id: "root", node_id: null, node_name: null, status: "succeeded" },
];

function frame(event: LogEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A stub SSE server; `onRequest` decides which frames to write (and whether to drop) per request. */
function startStub(onRequest: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(onRequest);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

/** Resolve when `predicate` holds, polling the microtask/timer queue. */
function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > 2000) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("subscribeRunEvents", () => {
  it("streams the full narrative and closes when the root run is terminal", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const e of EVENTS) res.write(frame(e));
      res.end();
    });
    server = stub.server;

    const seen: number[] = [];
    let closed = false;
    subscribeRunEvents({
      baseUrl: stub.url,
      rootRunId: "root",
      onEvent: (e) => seen.push(e.seq),
      onClose: () => {
        closed = true;
      },
    });

    await waitFor(() => closed);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("reconnects with Last-Event-ID after a mid-run drop, filling the gap with no duplicate", async () => {
    const lastEventIds: (string | undefined)[] = [];
    let connection = 0;
    const stub = await startStub((req, res) => {
      lastEventIds.push(req.headers["last-event-id"] as string | undefined);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (connection++ === 0) {
        // Deliberate mid-run drop: send the first two frames, then end without a terminal event.
        res.write(frame(EVENTS[0]!));
        res.write(frame(EVENTS[1]!));
        res.end();
        return;
      }
      // Reconnect: replay strictly after Last-Event-ID, through the terminal frame.
      const after = Number(req.headers["last-event-id"] ?? 0);
      for (const e of EVENTS.filter((ev) => ev.seq > after)) res.write(frame(e));
      res.end();
    });
    server = stub.server;

    const seen: number[] = [];
    let closed = false;
    subscribeRunEvents({
      baseUrl: stub.url,
      rootRunId: "root",
      onEvent: (e) => seen.push(e.seq),
      onClose: () => {
        closed = true;
      },
    });

    await waitFor(() => closed);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(lastEventIds).toEqual([undefined, "2"]);
  });

  it("reports the stream open, and reconnecting when a mid-run drop sends it back", async () => {
    let connection = 0;
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (connection++ === 0) {
        // Ends without a terminal event: the run is still going, so the core must reconnect.
        res.write(frame(EVENTS[0]!));
        res.end();
        return;
      }
      res.write(frame(EVENTS[3]!));
      res.end();
    });
    server = stub.server;

    const phases: string[] = [];
    let closed = false;
    subscribeRunEvents({
      baseUrl: stub.url,
      rootRunId: "root",
      onEvent: () => {},
      onOpen: () => phases.push("open"),
      onReconnecting: () => phases.push("reconnecting"),
      onClose: () => {
        phases.push("closed");
        closed = true;
      },
    });

    await waitFor(() => closed);
    expect(phases).toEqual(["open", "reconnecting", "open", "closed"]);
  });

  it("does not call a stream that ended mid-run complete when reconnect is off", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(frame(EVENTS[0]!));
      res.end();
    });
    server = stub.server;

    let closes = 0;
    let error: unknown;
    subscribeRunEvents({
      baseUrl: stub.url,
      rootRunId: "root",
      reconnect: false,
      onEvent: () => {},
      onClose: () => {
        closes++;
      },
      onError: (err) => {
        error = err;
      },
    });

    // "Complete" is a claim about the run, not about the socket: the root run never finished here.
    await waitFor(() => error !== undefined);
    expect(closes).toBe(0);
    expect((error as Error).message).toContain("ended before the root run finished");
  });

  it("stops delivering and does not reconnect after close()", async () => {
    let connections = 0;
    const stub = await startStub((_req, res) => {
      connections++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(frame(EVENTS[0]!));
      // Never end and never send a terminal — the run stays live.
    });
    server = stub.server;

    const seen: number[] = [];
    const sub = subscribeRunEvents({ baseUrl: stub.url, rootRunId: "root", onEvent: (e) => seen.push(e.seq) });

    await waitFor(() => seen.length === 1);
    sub.close();
    const connectionsAtClose = connections;
    // Give any erroneous reconnect a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(connectionsAtClose);
    expect(seen).toEqual([1]);
  });
});
