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
      worker: { type: "engine" },
      status: "succeeded",
      started_at: "2026-07-25T10:00:00.000Z",
      finished_at: "2026-07-25T10:00:02.000Z",
      input_ref: null,
      output_ref: null,
      usage: null,
      estimated_cost_usd: null,
    },
  ],
};

const RUNS = { runs: [{ run_id: RUN, status: "succeeded", started_at: null, finished_at: null }] };

describe("App", () => {
  it("frames the three panes of the pinned console layout", async () => {
    render(<App client={stubClient()} />);

    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Run detail" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Node I/O" })).toBeInTheDocument();
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

    expect(screen.getByRole("region", { name: "Node I/O" })).toHaveTextContent(RUN);
  });
});
