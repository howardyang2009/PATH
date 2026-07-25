import type { PathApiClient } from "@path/client-core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunDetail } from "../src/run-detail.js";
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

function renderDetail(client: PathApiClient, onSelectRun = vi.fn()) {
  const view = render(
    <RunDetail client={client} rootRunId={ROOT} selectedRunId={null} onSelectRun={onSelectRun} />,
  );
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

  it("reports a run that the server does not know", async () => {
    renderDetail(stubClient({ tree: { error: { message: "run not found" } }, treeStatus: 404 }));

    expect(await screen.findByRole("alert")).toHaveTextContent("run not found");
  });
});
