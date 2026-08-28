import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { stubClient } from "./stub-server.js";

const RUN = "run_abc";

const TREE = {
  root_run_id: RUN,
  status: "succeeded",
  output: null,
  runs: [
    {
      run_id: RUN,
      root_run_id: RUN,
      parent_run_id: null,
      node_id: null,
      worker_name: "spawn",
      status: "succeeded",
      started_at: "2026-07-25T10:00:00.000Z",
      finished_at: "2026-07-25T10:00:02.000Z",
      input_ref: `runs/${RUN}/${RUN}/input.json`,
      output_ref: `runs/${RUN}/${RUN}/output.json`,
      usage: null,
      estimated_cost_usd: null,
    },
  ],
};

const RUNS = { runs: [{ run_id: RUN, status: "succeeded", started_at: null, finished_at: null }] };

describe("App", () => {
  it("frames the three panes of the pinned console layout", async () => {
    render(<App client={stubClient()} />);

    // The left rail is split into two named panes; the centre and right complete the console.
    expect(screen.getByRole("region", { name: "Workflows" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Run detail" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Node I/O/C" })).toBeInTheDocument();
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
  });

  it("owns the selected root run id and opens it in the detail pane", async () => {
    render(<App client={stubClient({ runs: RUNS, tree: TREE })} />);

    fireEvent.click(await screen.findByTestId(`run-row-${RUN}`));

    const detail = screen.getByRole("region", { name: "Run detail" });
    expect(await screen.findByTestId("run-head")).toHaveTextContent("succeeded");
    expect(detail).toHaveTextContent(RUN);
  });

  it("owns the run selected in the tree and exposes it to the node-I/O pane", async () => {
    render(<App client={stubClient({ runs: RUNS, tree: TREE })} />);

    fireEvent.click(await screen.findByTestId(`run-row-${RUN}`));
    fireEvent.click(await screen.findByTestId(`tree-row-${RUN}`));

    expect(screen.getByRole("region", { name: "Node I/O/C" })).toHaveTextContent(RUN);
  });

  it("opens a run, selects a node in its tree and shows that run's blobs — the four read verbs", async () => {
    const client = stubClient({
      runs: RUNS,
      tree: TREE,
      blobs: { [`${RUN}/input`]: { since_tag: "1.3.0" }, [`${RUN}/output`]: { count: 3 } },
    });
    render(<App client={client} />);

    fireEvent.click(await screen.findByTestId(`run-row-${RUN}`));
    fireEvent.click(await screen.findByTestId(`tree-row-${RUN}`));

    expect(await screen.findByTestId("node-io-input")).toHaveTextContent('"since_tag": "1.3.0"');
    expect(await screen.findByTestId("node-io-output")).toHaveTextContent('"count": 3');
  });

  it("drops the node selection when the root run changes, so the pane never shows a foreign run", async () => {
    const other = "run_other";
    const runs = {
      runs: [
        { run_id: RUN, status: "succeeded", started_at: null, finished_at: null },
        { run_id: other, status: "running", started_at: null, finished_at: null },
      ],
    };
    render(<App client={stubClient({ runs, tree: TREE })} />);

    fireEvent.click(await screen.findByTestId(`run-row-${RUN}`));
    fireEvent.click(await screen.findByTestId(`tree-row-${RUN}`));
    expect(await screen.findByTestId("node-io-head")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`run-row-${other}`));

    expect(screen.queryByTestId("node-io-head")).toBeNull();
    expect(screen.getByRole("region", { name: "Node I/O/C" })).toHaveTextContent("Select a run in the tree.");
  });
});
