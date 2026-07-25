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
  /**
   * Bodies for `GET /v0/runs/:root_run_id/blobs/:run_id/:name`, keyed `"<run_id>/<name>"`. A key the
   * map does not hold answers 404 with the error envelope — exactly as the real route does for a
   * blob that has not been written yet (`get-run-blob.ts`). Read on every request, so a test can
   * add a blob mid-render and prove the pane re-reads it.
   */
  blobs?: Record<string, unknown>;
  /** Status for a blob that *is* in `blobs` — for the failure path (e.g. 500). */
  blobStatus?: number;
}

export function stubClient(options: StubServerOptions = {}): PathApiClient {
  const { runs = { runs: [] }, tree = { runs: [] }, treeStatus = 200, stream } = options;

  const fetchLike: FetchLike = async (input, init) => {
    if (input.endsWith("/events")) {
      const body = (stream ?? new EventStreamStub()).body(init?.signal);
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    const blobKey = blobKeyOf(input);
    if (blobKey !== null) {
      const blobs = options.blobs ?? {};
      if (!(blobKey in blobs)) {
        return json({ error: { message: `no blob "${blobKey}"` } }, 404);
      }
      return json(blobs[blobKey], options.blobStatus ?? 200);
    }
    const isRunsList = input === "/v0/runs" || input.startsWith("/v0/runs?");
    return json(isRunsList ? runs : tree, isRunsList ? 200 : treeStatus);
  };

  return new PathApiClient({ baseUrl: "", fetch: fetchLike });
}

/** `"<run_id>/<name>"` for a blob-route URL, or null for any other path. */
function blobKeyOf(url: string): string | null {
  const match = /^\/v0\/runs\/[^/]+\/blobs\/([^/]+)\/([^/?]+)$/.exec(url);
  return match ? `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}` : null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
