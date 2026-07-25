import type { RunNodeState } from "@path/client-core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunTree } from "../src/run-tree.js";

const ROOT = "run_root";

function run(overrides: Partial<RunNodeState> & { runId: string }): RunNodeState {
  return {
    rootRunId: ROOT,
    parentRunId: ROOT,
    nodeId: "step",
    worker: { type: "engine" },
    status: "running",
    startedAt: null,
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    ...overrides,
  };
}

function tree(...runs: RunNodeState[]) {
  const map = new Map(runs.map((entry) => [entry.runId, entry]));
  return render(
    <RunTree rootRunId={ROOT} runs={map} selectedRunId={null} onSelectRun={vi.fn()} />,
  );
}

const ROOT_RUN = run({ runId: ROOT, parentRunId: null, nodeId: null });

describe("RunTree", () => {
  it("orders siblings oldest-first, with a run that has not started last", () => {
    tree(
      ROOT_RUN,
      run({ runId: "run_late", nodeId: "late", startedAt: "2026-07-25T10:00:02.000Z" }),
      run({ runId: "run_pending", nodeId: "pending", status: "pending" }),
      run({ runId: "run_early", nodeId: "early", startedAt: "2026-07-25T10:00:01.000Z" }),
    );

    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels.filter((label) => label !== null).join(" ")).toMatch(/early.*late.*pending/s);
  });

  it("hangs a run whose parent the tree does not have off the root", () => {
    // The stream is ahead of the last tree read: the run exists, its parentage is not known yet.
    tree(ROOT_RUN, run({ runId: "run_orphan", parentRunId: "run_missing", nodeId: "orphan" }));

    const rootItem = screen.getByTestId(`tree-item-${ROOT}`);
    expect(within(rootItem).getByTestId("tree-row-run_orphan")).toBeInTheDocument();
  });

  it("reports a root run with no rows rather than rendering an empty tree", () => {
    render(
      <RunTree
        rootRunId={ROOT}
        runs={new Map<string, RunNodeState>()}
        selectedRunId={null}
        onSelectRun={vi.fn()}
      />,
    );

    expect(screen.getByText("No runs recorded for this root run.")).toBeInTheDocument();
  });

  it("marks the selected run so the node-I/O pane and the tree agree", () => {
    const map = new Map([
      [ROOT, ROOT_RUN],
      ["run_a", run({ runId: "run_a", nodeId: "step-a" })],
    ]);
    render(<RunTree rootRunId={ROOT} runs={map} selectedRunId="run_a" onSelectRun={vi.fn()} />);

    expect(screen.getByTestId("tree-row-run_a")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId(`tree-row-${ROOT}`)).not.toHaveAttribute("aria-current");
  });
});
