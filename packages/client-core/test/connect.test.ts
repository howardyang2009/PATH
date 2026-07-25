import { describe, expect, it } from "vitest";
import { PathApiClient, type FetchLike } from "../src/api-client.js";
import { connectRunViewModel } from "../src/connect.js";
import type { WireRunRecord } from "../src/wire-types.js";

const ROOT = "root-1";
const CHILD = "child-1";

function record(overrides: Partial<WireRunRecord> & { run_id: string }): WireRunRecord {
  return {
    root_run_id: ROOT,
    parent_run_id: ROOT,
    node_id: "draft",
    worker: { type: "engine" },
    status: "running",
    started_at: "t0",
    finished_at: null,
    input_ref: null,
    output_ref: null,
    usage: null,
    estimated_cost_usd: null,
    ...overrides,
  };
}

const ROOT_ROW = record({ run_id: ROOT, parent_run_id: null, node_id: null });

function frame(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`id: ${String(event["seq"])}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** An SSE body that stays open, as the server's does until the root run goes terminal. */
class EventStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  body(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  push(event: Record<string, unknown>): void {
    this.controller?.enqueue(frame(event));
  }
}

/** Serves a fresh tree per `GET /v0/runs/:id` — `trees.shift()` models the run moving on. */
function stubFetch(trees: WireRunRecord[][], stream: EventStream): { fetch: FetchLike; treeReads: number } {
  const state = { treeReads: 0 };
  const fetch: FetchLike = async (input) => {
    if (input.endsWith("/events")) {
      return new Response(stream.body(), { status: 200 });
    }
    state.treeReads += 1;
    const runs = trees.length > 1 ? trees.shift()! : trees[0]!;
    return new Response(JSON.stringify({ root_run_id: ROOT, status: "running", output: null, runs }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    fetch,
    get treeReads() {
      return state.treeReads;
    },
  };
}

/** Let the microtask queue drain — the re-read is a promise chain, not a timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("connectRunViewModel", () => {
  it("re-reads the tree when the stream names a run the tree did not have", async () => {
    const stream = new EventStream();
    const stub = stubFetch([[ROOT_ROW], [ROOT_ROW, record({ run_id: CHILD })]], stream);
    const client = new PathApiClient({ baseUrl: "", fetch: stub.fetch });

    const connected = await connectRunViewModel({ client, rootRunId: ROOT });
    expect(connected.model.getState().runs.has(CHILD)).toBe(false);

    // A log event carries no `parent_run_id`, so the child would hang parentless without the re-read.
    stream.push({
      type: "step-started",
      seq: 1,
      ts: "t1",
      run_id: CHILD,
      node_id: "draft",
      step_type: "binary",
      worker: { type: "engine" },
    });
    await settle();

    expect(connected.model.getState().runs.get(CHILD)?.parentRunId).toBe(ROOT);
    expect(stub.treeReads).toBe(2);
    connected.close();
  });

  it("does not re-read for a run the tree already described", async () => {
    const stream = new EventStream();
    const stub = stubFetch([[ROOT_ROW, record({ run_id: CHILD })]], stream);
    const client = new PathApiClient({ baseUrl: "", fetch: stub.fetch });

    const connected = await connectRunViewModel({ client, rootRunId: ROOT });
    stream.push({ type: "step-finished", seq: 1, ts: "t1", run_id: CHILD, node_id: "draft", status: "succeeded" });
    await settle();

    expect(connected.model.getState().runs.get(CHILD)?.status).toBe("succeeded");
    expect(stub.treeReads).toBe(1);
    connected.close();
  });
});
