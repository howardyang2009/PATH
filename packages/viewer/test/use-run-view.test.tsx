import { PathApiClient, type FetchLike } from "@path/client-core";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRunView, type RunViewLoad } from "../src/use-run-view.js";

const ROOT = "run_root";

const TREE = {
  root_run_id: ROOT,
  status: "running",
  output: null,
  runs: [
    {
      run_id: ROOT,
      root_run_id: ROOT,
      parent_run_id: null,
      node_id: null,
      worker: { type: "engine" },
      status: "running",
      started_at: "2026-07-25T10:00:00.000Z",
      finished_at: null,
      input_ref: null,
      output_ref: null,
      usage: null,
      estimated_cost_usd: null,
    },
  ],
};

/** Records the abort signal of every event-stream request, so teardown is observable. */
function trackingClient(): { client: PathApiClient; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    if (input.endsWith("/events")) {
      if (init?.signal) signals.push(init.signal);
      // An open stream, as the server holds until the root run goes terminal.
      return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 });
    }
    return new Response(JSON.stringify(TREE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { client: new PathApiClient({ baseUrl: "", fetch: fetchLike }), signals };
}

describe("useRunView", () => {
  it("closes the event stream when the pane unmounts", async () => {
    const { client, signals } = trackingClient();
    const { result, unmount } = renderHook(() => useRunView(client, ROOT));

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(signals).toHaveLength(1);

    unmount();

    expect(signals[0]?.aborted).toBe(true);
  });

  it("drops the previous run's stream when the watched run changes", async () => {
    const { client, signals } = trackingClient();
    const { result, rerender } = renderHook(({ rootRunId }) => useRunView(client, rootRunId), {
      initialProps: { rootRunId: ROOT },
    });

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    rerender({ rootRunId: "run_other" });

    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("stays idle with no run selected, and opens nothing", async () => {
    const { client, signals } = trackingClient();
    const { result, rerender } = renderHook<RunViewLoad, { rootRunId: string | null }>(
      ({ rootRunId }) => useRunView(client, rootRunId),
      { initialProps: { rootRunId: null } },
    );

    expect(result.current.phase).toBe("idle");
    expect(signals).toHaveLength(0);

    rerender({ rootRunId: ROOT });

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(signals).toHaveLength(1);
  });
});
