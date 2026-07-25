import { PathApiClient, type FetchLike } from "@path/client-core";

/**
 * A stand-in `path-server` for viewer tests: one injected `fetch` routing the three read endpoints
 * the viewer uses (`GET /v0/runs`, `GET /v0/runs/:id`, `GET /v0/runs/:id/events`). Nothing is
 * mocked above the transport, so tests exercise the real `@path/client-core` decode, SSE parse and
 * view-model folding.
 */

function frame(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`id: ${String(event["seq"])}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * An SSE body that stays open, like the real one: the server only closes the stream when the root
 * run goes terminal, and a stream that ends early would send the core's reconnect loop spinning.
 * `push` plays a live event into the open stream.
 */
export class EventStreamStub {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  body(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        signal?.addEventListener("abort", () => {
          try {
            controller.close();
          } catch {
            // Already closed by an earlier abort — nothing to tear down.
          }
        });
      },
    });
  }

  push(event: Record<string, unknown>): void {
    this.controller?.enqueue(frame(event));
  }
}

export interface StubServerOptions {
  /** Body for `GET /v0/runs` — the runs-list window. */
  runs?: unknown;
  /** Body for `GET /v0/runs/:root_run_id` — the run tree. */
  tree?: unknown;
  /** Status for the tree response, for the not-found path. */
  treeStatus?: number;
  /** Supply one to push live events into the open stream; omitted means a silent stream. */
  stream?: EventStreamStub;
}

export function stubClient(options: StubServerOptions = {}): PathApiClient {
  const { runs = { runs: [] }, tree = { runs: [] }, treeStatus = 200, stream } = options;

  const fetchLike: FetchLike = async (input, init) => {
    if (input.endsWith("/events")) {
      const body = (stream ?? new EventStreamStub()).body(init?.signal);
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    const isRunsList = input === "/v0/runs" || input.startsWith("/v0/runs?");
    return json(isRunsList ? runs : tree, isRunsList ? 200 : treeStatus);
  };

  return new PathApiClient({ baseUrl: "", fetch: fetchLike });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
