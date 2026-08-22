import { describe, expect, it } from "vitest";
import { PathApiClient, type FetchLike } from "../src/api-client.js";
import { connectRunViewModel } from "../src/connect.js";
import type { WireRunRecord } from "@path/schema";

const ROOT = "root-1";
const CHILD = "child-1";

function record(overrides: Partial<WireRunRecord> & { run_id: string }): WireRunRecord {
  return {
    root_run_id: ROOT,
    parent_run_id: ROOT,
    node_id: "draft",
    node_name: "draft",
    worker: { type: "engine" },
    status: "running",
    started_at: "t0",
    finished_at: null,
    input_ref: null,
    output_ref: null,
    usage: null,
    estimated_cost_usd: null,
    resumed_from_root_run_id: null,
    reused_from_run_id: null,
    workflow_id: null,
    workflow_name: null,
    workflow_path: null,
    ...overrides,
  };
}

const ROOT_ROW = record({ run_id: ROOT, parent_run_id: null, node_id: null, node_name: null });

function frame(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`id: ${String(event["seq"])}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** An SSE body that stays open, as the server's does until the root run goes terminal. */
class EventStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** How many times a body has been handed out — one per connect, so reconnects are countable. */
  opens = 0;

  body(): ReadableStream<Uint8Array> {
    this.opens += 1;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  push(event: Record<string, unknown>): void {
    this.controller?.enqueue(frame(event));
  }

  /** End the body without closing the subscription — the transport dropping under a live run. */
  end(): void {
    this.controller?.close();
    this.controller = null;
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

/** Resolve when `predicate` holds — the reconnect loop spans several turns of the event loop. */
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
      node_name: "draft",
      step_type: "binary",
      worker: { type: "engine" },
    });
    // `runs.has(CHILD)` holds the moment the event folds — the placeholder node the fold creates
    // carries `parentRunId: null`. The re-read landing is what fills the link in, so that is the
    // condition to settle on; *which* parent it learned stays an assertion.
    await waitFor(() => connected.model.getState().runs.get(CHILD)?.parentRunId != null);

    expect(connected.model.getState().runs.get(CHILD)?.parentRunId).toBe(ROOT);
    expect(stub.treeReads).toBe(2);
    connected.close();
  });

  it("does not re-read for a run the tree already described", async () => {
    const stream = new EventStream();
    const stub = stubFetch([[ROOT_ROW, record({ run_id: CHILD })]], stream);
    const client = new PathApiClient({ baseUrl: "", fetch: stub.fetch });

    const connected = await connectRunViewModel({ client, rootRunId: ROOT });
    stream.push({ type: "step-finished", seq: 1, ts: "t1", run_id: CHILD, node_id: "draft", node_name: "draft", status: "succeeded" });
    // The re-read decision is made in the same callback turn as the fold, so once the status has
    // moved, a re-read would already have been issued — `treeReads` staying 1 is decided by then.
    await waitFor(() => connected.model.getState().runs.get(CHILD)?.status === "succeeded");

    expect(connected.model.getState().runs.get(CHILD)?.status).toBe("succeeded");
    expect(stub.treeReads).toBe(1);
    connected.close();
  });

  it("marks the stream live once the subscription is open", async () => {
    const stream = new EventStream();
    const stub = stubFetch([[ROOT_ROW]], stream);
    const client = new PathApiClient({ baseUrl: "", fetch: stub.fetch });

    const connected = await connectRunViewModel({ client, rootRunId: ROOT });
    await waitFor(() => connected.model.getState().stream === "live");

    connected.close();
  });

  it("reports reconnecting on a mid-run drop, then live again", async () => {
    const stream = new EventStream();
    const stub = stubFetch([[ROOT_ROW]], stream);
    const client = new PathApiClient({ baseUrl: "", fetch: stub.fetch });

    const connected = await connectRunViewModel({ client, rootRunId: ROOT });
    await waitFor(() => connected.model.getState().stream === "live");

    const phases: string[] = [connected.model.getState().stream];
    connected.model.subscribe((state) => {
      if (phases.at(-1) !== state.stream) phases.push(state.stream);
    });

    // The root run has not finished, so an ended body is a drop, not a completion.
    stream.end();

    await waitFor(() => stream.opens === 2 && connected.model.getState().stream === "live");
    expect(phases).toEqual(["live", "reconnecting", "live"]);
    connected.close();
  });

  it("marks the stream closed when the root run goes terminal", async () => {
    const stream = new EventStream();
    const stub = stubFetch([[ROOT_ROW]], stream);
    const client = new PathApiClient({ baseUrl: "", fetch: stub.fetch });

    const connected = await connectRunViewModel({ client, rootRunId: ROOT });
    await waitFor(() => connected.model.getState().stream === "live");

    // The implicit root step finishing (`node_id: null`) is what closes the stream for good.
    stream.push({ type: "step-finished", seq: 1, ts: "t1", run_id: ROOT, node_id: null, node_name: null, status: "succeeded" });
    // The end below is a completion, not a drop, only if the terminal event was seen first — and the
    // subscription records terminality before handing the event to the fold, so the root status
    // moving means the stream already knows.
    await waitFor(() => connected.model.getState().status === "succeeded");
    stream.end();

    await waitFor(() => connected.model.getState().stream === "closed");
    expect(stream.opens).toBe(1);
    connected.close();
  });
});
