import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { DEFAULT_PLUGINS, stubClient } from "./stub-server.js";

/**
 * #620 — a watched run with goto passes (docs/spec/goto.md §9, designer-spec § goto, G-D-08): the goto block
 * takes no status tint, it shows its jumps spent as `<spent>/<max_jumps>`, and a node revisited in several
 * passes shows its latest run. A goto-free run renders as before.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PATH = "flows/main.workflow.json";
const WF_ID = uuid(1);
const ALPHA_ID = uuid(2);
const HOP_ID = uuid(3);
const TAIL_ID = uuid(4);

/** alpha · hop (goto → alpha, backward, max 3) · tail. */
function gotoFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: WF_ID,
    name: "flow",
    body: [
      { type: "prompt", id: ALPHA_ID, name: "alpha", prompt: "a" },
      { type: "goto", id: HOP_ID, name: "hop", target: "alpha", max_jumps: 3 },
      { type: "prompt", id: TAIL_ID, name: "tail", prompt: "t" },
    ],
  };
}

function canonicalBytes(file: Record<string, unknown>): string {
  const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);
  if (result.status !== "opened") throw new Error(`fixture did not open: ${result.status}`);
  return canonicalSerialize(result.file);
}

/** A wire run row under the watched root `root-1`; the fields the projection does not read are inert nulls. */
function wireRun(partial: {
  run_id: string;
  status: string;
  parent_run_id?: string | null;
  node_id?: string | null;
  pass?: number | null;
  started_at?: string;
}): Record<string, unknown> {
  return {
    run_id: partial.run_id,
    root_run_id: "root-1",
    parent_run_id:
      partial.parent_run_id === undefined
        ? partial.run_id === "root-1"
          ? null
          : "root-1"
        : partial.parent_run_id,
    node_id: partial.node_id ?? null,
    node_name: null,
    worker_name: null,
    iteration: null,
    pass: partial.pass ?? null,
    status: partial.status,
    started_at: partial.started_at ?? "2026-01-01T00:00:00Z",
    finished_at: null,
    input_ref: null,
    output_ref: null,
    usage: null,
    estimated_cost_usd: null,
    resumed_from_root_run_id: null,
    rerun_from_node_path: null,
    reused_from_run_id: null,
    reused_from_root_run_id: null,
    workflow_id: WF_ID,
    workflow_name: "flow",
    workflow_path: PATH,
  };
}

/** Open the goto file, watch `root-1` over `runs`, and return the canvas. */
async function watch(runs: Record<string, unknown>[]): Promise<HTMLElement> {
  const client = stubClient({
    files: { [PATH]: canonicalBytes(gotoFile()) },
    runs: {
      runs: [
        {
          run_id: "root-1",
          workflow_name: "flow",
          workflow_id: WF_ID,
          workflow_path: PATH,
          status: "running",
          started_at: "2026-01-01T00:00:00Z",
          finished_at: null,
        },
      ],
    },
    tree: { root_run_id: "root-1", status: "running", output: null, runs },
  });
  render(<App client={client} initialPath={PATH} />);
  const canvas = await screen.findByRole("region", { name: "Workflow canvas" });
  fireEvent.click(screen.getByTestId("run-dock-toggle"));
  fireEvent.click(await screen.findByTestId("run-row-root-1"));
  return canvas;
}

function block(canvas: HTMLElement, id: string): HTMLElement {
  return canvas.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
}

describe("G-D-08 watched run with passes", () => {
  it("leaves the goto untinted, badges its jumps spent, and shows a revisited node's latest run", async () => {
    // Pass 1 ran alpha (failed), hop jumped back twice: pass 2 re-ran alpha (succeeded), pass 3 is running tail.
    const canvas = await watch([
      wireRun({ run_id: "root-1", status: "running" }),
      wireRun({ run_id: "p1", pass: 1, status: "succeeded", started_at: "2026-01-01T00:00:01Z" }),
      wireRun({
        run_id: "a1",
        parent_run_id: "p1",
        node_id: ALPHA_ID,
        status: "failed",
        started_at: "2026-01-01T00:00:02Z",
      }),
      wireRun({
        run_id: "p2",
        node_id: HOP_ID,
        pass: 2,
        status: "succeeded",
        started_at: "2026-01-01T00:00:03Z",
      }),
      wireRun({
        run_id: "a2",
        parent_run_id: "p2",
        node_id: ALPHA_ID,
        status: "succeeded",
        started_at: "2026-01-01T00:00:04Z",
      }),
      wireRun({
        run_id: "p3",
        node_id: HOP_ID,
        pass: 3,
        status: "running",
        started_at: "2026-01-01T00:00:05Z",
      }),
      wireRun({
        run_id: "t3",
        parent_run_id: "p3",
        node_id: TAIL_ID,
        status: "running",
        started_at: "2026-01-01T00:00:06Z",
      }),
    ]);

    const jumps = await screen.findByTestId(`goto-jumps-${HOP_ID}`);
    expect(jumps).toHaveTextContent("2/3");
    expect(block(canvas, HOP_ID)).toContainElement(jumps);
    expect(screen.queryByTestId(`node-run-badge-${HOP_ID}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`node-run-badge-${ALPHA_ID}`)).toHaveAttribute(
      "data-run-status",
      "succeeded",
    );
    expect(screen.getByTestId(`node-run-badge-${TAIL_ID}`)).toHaveAttribute(
      "data-run-status",
      "running",
    );
  });

  it("badges a goto that never jumped as 0/<max_jumps>", async () => {
    const canvas = await watch([
      wireRun({ run_id: "root-1", status: "running" }),
      wireRun({ run_id: "p1", pass: 1, status: "running" }),
      wireRun({ run_id: "a1", parent_run_id: "p1", node_id: ALPHA_ID, status: "running" }),
    ]);
    const jumps = await screen.findByTestId(`goto-jumps-${HOP_ID}`);
    expect(jumps).toHaveTextContent("0/3");
    expect(block(canvas, HOP_ID)).toContainElement(jumps);
  });

  it("draws no jumps badge while no run is watched", async () => {
    render(
      <App
        client={stubClient({ files: { [PATH]: canonicalBytes(gotoFile()) } })}
        initialPath={PATH}
      />,
    );
    const canvas = await screen.findByRole("region", { name: "Workflow canvas" });
    await within(canvas).findByText("hop");
    expect(screen.queryByTestId(`goto-jumps-${HOP_ID}`)).not.toBeInTheDocument();
  });
});
