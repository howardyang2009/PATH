import { PathApiError, type PathApiClient } from "@path/client-core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ARM_TIMEOUT_MS } from "../src/cancel-button.js";
import { RunDetail } from "../src/run-detail.js";
import { useRunView } from "../src/use-run-view.js";
import { EventStreamStub, stubClient } from "./stub-server.js";

const ROOT = "run_root";

/** One wire run record with the shape of `GET /v0/runs/:root_run_id` (server-api-v0.md §4). */
function record(overrides: Record<string, unknown>) {
  return {
    run_id: "run_x",
    root_run_id: ROOT,
    parent_run_id: ROOT,
    node_id: "step-x",
    worker: { type: "engine" },
    status: "pending",
    started_at: null,
    finished_at: null,
    input_ref: null,
    output_ref: null,
    usage: null,
    estimated_cost_usd: null,
    ...overrides,
  };
}

/** Root -> (a, b) -> (c under b): enough shape to prove nesting, not just a flat list. */
const TREE = {
  root_run_id: ROOT,
  status: "running",
  output: null,
  runs: [
    record({
      run_id: ROOT,
      parent_run_id: null,
      node_id: null,
      status: "running",
      started_at: "2026-07-25T10:00:00.000Z",
    }),
    record({ run_id: "run_a", node_id: "step-a", status: "succeeded" }),
    record({ run_id: "run_b", node_id: "step-b", status: "running" }),
    record({ run_id: "run_c", parent_run_id: "run_b", node_id: "step-c", status: "pending" }),
  ],
};

/**
 * The pane is a view over a snapshot the app owns (one connection feeds the detail and node-I/O
 * panes), so the tests connect it the way the app does rather than reaching past `useRunView`.
 */
function ConnectedDetail({ client, onSelectRun }: { client: PathApiClient; onSelectRun: () => void }) {
  const load = useRunView(client, ROOT);
  return <RunDetail client={client} load={load} rootRunId={ROOT} selectedRunId={null} onSelectRun={onSelectRun} />;
}

function renderDetail(client: PathApiClient, onSelectRun = vi.fn()) {
  const view = render(<ConnectedDetail client={client} onSelectRun={onSelectRun} />);
  return { ...view, onSelectRun };
}

describe("RunDetail", () => {
  it("heads the pane with the root run id and its status", async () => {
    renderDetail(stubClient({ tree: TREE }));

    const head = await screen.findByTestId("run-head");
    expect(head).toHaveTextContent(ROOT);
    expect(head).toHaveTextContent("running");
  });

  it("nests child runs under their parent rather than listing them flat", async () => {
    renderDetail(stubClient({ tree: TREE }));

    const rootItem = await screen.findByTestId("tree-item-run_root");
    expect(within(rootItem).getByTestId("tree-row-run_a")).toBeInTheDocument();

    // run_c hangs off run_b, not off the root: the tree is the parent/child structure, not a list.
    const bItem = within(rootItem).getByTestId("tree-item-run_b");
    expect(within(bItem).getByTestId("tree-row-run_c")).toBeInTheDocument();
  });

  it("labels a run by its node id, and the implicit root step as the root", async () => {
    renderDetail(stubClient({ tree: TREE }));

    expect(await screen.findByTestId("tree-row-run_a")).toHaveTextContent("step-a");
    expect(screen.getByTestId("tree-row-run_root")).toHaveTextContent("root");
  });

  it("collapses a subtree without losing the collapsed run's own row", async () => {
    renderDetail(stubClient({ tree: TREE }));

    const toggle = await screen.findByTestId("tree-toggle-run_b");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("tree-row-run_c")).not.toBeInTheDocument();
    expect(screen.getByTestId("tree-row-run_b")).toBeInTheDocument();
  });

  it("gives no disclosure control to a leaf run", async () => {
    renderDetail(stubClient({ tree: TREE }));

    await screen.findByTestId("tree-row-run_a");
    expect(screen.queryByTestId("tree-toggle-run_a")).not.toBeInTheDocument();
  });

  it("folds live events into the tree as the run executes", async () => {
    const stream = new EventStreamStub();
    renderDetail(stubClient({ tree: TREE, stream }));

    expect(await screen.findByTestId("tree-row-run_c")).toHaveTextContent("pending");

    await act(async () => {
      stream.push({
        type: "step-started",
        seq: 7,
        ts: "2026-07-25T10:00:05.000Z",
        run_id: "run_c",
        node_id: "step-c",
        step_type: "binary",
        worker: { type: "engine" },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("tree-row-run_c")).toHaveTextContent("running");
    });
  });

  it("lifts the clicked run so the node-I/O pane can resolve it", async () => {
    const { onSelectRun } = renderDetail(stubClient({ tree: TREE }));

    fireEvent.click(await screen.findByTestId("tree-row-run_a"));

    expect(onSelectRun).toHaveBeenCalledWith("run_a");
  });

  it("streams the narrative under the tree as events land", async () => {
    const stream = new EventStreamStub();
    renderDetail(stubClient({ tree: TREE, stream }));

    await screen.findByTestId("narrative-empty");

    await act(async () => {
      stream.push({
        type: "step-started",
        seq: 7,
        ts: "2026-07-25T10:00:05.000Z",
        run_id: "run_c",
        node_id: "step-c",
        step_type: "binary",
        worker: { type: "engine" },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("narrative-events")).toHaveTextContent("step-c started · engine");
    });
  });

  it("shows one row per seq when a replay overlaps what is already on screen", async () => {
    const stream = new EventStreamStub();
    renderDetail(stubClient({ tree: TREE, stream }));
    await screen.findByTestId("narrative-empty");

    const event = {
      type: "step-finished",
      seq: 9,
      ts: "2026-07-25T10:00:06.000Z",
      run_id: "run_a",
      node_id: "step-a",
      status: "succeeded",
    };

    // What a mid-run reload does: the resumed stream replays a seq the view already folded in.
    await act(async () => {
      stream.push(event);
      stream.push(event);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("event-seq-9")).toHaveLength(1);
    });
  });

  it("marks the narrative live while the stream is open", async () => {
    renderDetail(stubClient({ tree: TREE, stream: new EventStreamStub() }));

    await waitFor(() => {
      expect(screen.getByTestId("stream-indicator")).toHaveAttribute("data-phase", "live");
    });
  });

  it("reports a run that the server does not know", async () => {
    renderDetail(stubClient({ tree: { error: { message: "run not found" } }, treeStatus: 404 }));

    expect(await screen.findByRole("alert")).toHaveTextContent("run not found");
  });

  describe("cancel (#56)", () => {
    it("offers Cancel while the root run is pending or running", async () => {
      renderDetail(stubClient({ tree: TREE }));
      expect(await screen.findByTestId("cancel-button")).toHaveTextContent("Cancel run");
    });

    it("gives a terminal run nothing to cancel", async () => {
      const terminalTree = {
        ...TREE,
        status: "succeeded",
        runs: TREE.runs.map((row) => (row.run_id === ROOT ? { ...row, status: "succeeded" } : row)),
      };
      renderDetail(stubClient({ tree: terminalTree }));
      await screen.findByTestId("run-head");
      expect(screen.queryByTestId("cancel-button")).not.toBeInTheDocument();
    });

    it("requires an arm then a confirm before it sends", async () => {
      const client = stubClient({ tree: TREE });
      const cancelRun = vi.spyOn(client, "cancelRun").mockResolvedValue(undefined);
      renderDetail(client);

      const button = await screen.findByTestId("cancel-button");
      fireEvent.click(button);
      expect(button).toHaveTextContent("Confirm cancel?");
      expect(cancelRun).not.toHaveBeenCalled();

      fireEvent.click(button);
      expect(cancelRun).toHaveBeenCalledWith(ROOT);
    });

    it("disarms on blur without sending", async () => {
      const client = stubClient({ tree: TREE });
      const cancelRun = vi.spyOn(client, "cancelRun").mockResolvedValue(undefined);
      renderDetail(client);

      const button = await screen.findByTestId("cancel-button");
      fireEvent.click(button);
      expect(button).toHaveTextContent("Confirm cancel?");

      fireEvent.blur(button);
      expect(button).toHaveTextContent("Cancel run");
      fireEvent.click(button);
      expect(cancelRun).not.toHaveBeenCalled();
    });

    it("disarms on its own after the arm window passes", async () => {
      const client = stubClient({ tree: TREE });
      vi.spyOn(client, "cancelRun").mockResolvedValue(undefined);
      renderDetail(client);
      // Resolve the connect and find the button on real timers — only the arm window itself runs
      // under fake ones, so testing-library's own polling is not starved of ticks.
      const button = await screen.findByTestId("cancel-button");

      vi.useFakeTimers();
      try {
        fireEvent.click(button);
        expect(button).toHaveTextContent("Confirm cancel?");

        act(() => {
          vi.advanceTimersByTime(ARM_TIMEOUT_MS);
        });
        expect(button).toHaveTextContent("Cancel run");
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows Cancelling… once sent, disabled so it cannot be clicked again", async () => {
      const client = stubClient({ tree: TREE });
      vi.spyOn(client, "cancelRun").mockReturnValue(new Promise(() => {}));
      renderDetail(client);

      const button = await screen.findByTestId("cancel-button");
      fireEvent.click(button);
      fireEvent.click(button);

      expect(button).toHaveTextContent("Cancelling…");
      expect(button).toBeDisabled();
    });

    it("surfaces a 409 rather than claiming the cancel was sent", async () => {
      const client = stubClient({ tree: TREE });
      vi.spyOn(client, "cancelRun").mockRejectedValue(new PathApiError(409, "run is not executing here"));
      renderDetail(client);

      const button = await screen.findByTestId("cancel-button");
      fireEvent.click(button);
      fireEvent.click(button);

      expect(await screen.findByRole("alert")).toHaveTextContent("run is not executing here");
      // The claim "I sent your cancel" does not survive a 409 (#51's lesson) — the button goes back
      // to armable rather than sitting on a disabled "Cancelling…" that isn't true.
      expect(button).toHaveTextContent("Cancel run");
    });

    it("disappears once a terminal status folds in from the stream", async () => {
      const stream = new EventStreamStub();
      renderDetail(stubClient({ tree: TREE, stream }));
      await screen.findByTestId("cancel-button");

      await act(async () => {
        stream.push({
          type: "step-finished",
          seq: 7,
          ts: "2026-07-25T10:00:05.000Z",
          run_id: ROOT,
          node_id: null,
          status: "cancelled",
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.queryByTestId("cancel-button")).not.toBeInTheDocument();
      });
    });
  });

  // Resume (§4.3) lives in the runs rail now, under the selected row — its tests are in
  // runs-list.test.tsx. The detail header only carries Cancel.
  it("keeps Resume out of the detail header (it belongs to the runs rail)", async () => {
    const failedTree = {
      ...TREE,
      status: "failed",
      runs: TREE.runs.map((row) => (row.run_id === ROOT ? { ...row, status: "failed" } : row)),
    };
    renderDetail(stubClient({ tree: failedTree }));
    await screen.findByTestId("run-head");
    expect(screen.queryByTestId("resume-button")).not.toBeInTheDocument();
  });
});
