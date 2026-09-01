import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient, type StubCalls } from "./stub-server.js";

/** A distinct valid UUIDv4 per seed, so fixtures read as ids without a random source. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const ROOT_PATH = "flows/main.workflow.json";
const WF_ID = uuid(1);
const STEP_ID = uuid(2);

/** A clean, fully-id'd root file — opens without a stamp, so the buffer is clean and launch is enabled. */
function cleanFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: WF_ID,
    name: "root-flow",
    body: [{ type: "prompt", id: STEP_ID, name: "draft", prompt: "hi" }],
  };
}

/** An id-less file — the open pipeline stamps ids and opens the buffer dirty (ADR 0015). */
function dirtyFile(): Record<string, unknown> {
  return { format: FORMAT_VERSION, name: "no-ids", body: [{ type: "prompt", name: "draft", prompt: "hi" }] };
}

/** A wire run record with the fields the inspector/tree/projection read; the rest are inert nulls. */
function wireRun(partial: { run_id: string; status: string; node_id?: string | null; node_name?: string | null; output_ref?: string | null }): Record<string, unknown> {
  return {
    run_id: partial.run_id,
    root_run_id: partial.run_id === "root-1" ? "root-1" : "root-1",
    parent_run_id: partial.run_id === "root-1" ? null : "root-1",
    node_id: partial.node_id ?? null,
    node_name: partial.node_name ?? null,
    worker_name: null,
    status: partial.status,
    started_at: "2026-01-01T00:00:00Z",
    finished_at: null,
    input_ref: null,
    output_ref: partial.output_ref ?? null,
    usage: null,
    estimated_cost_usd: null,
    resumed_from_root_run_id: null,
    reused_from_run_id: null,
    reused_from_root_run_id: null,
    workflow_id: WF_ID,
    workflow_name: "root-flow",
    workflow_path: ROOT_PATH,
  };
}

function openDock(): void {
  fireEvent.click(screen.getByTestId("run-dock-toggle"));
}

/** Render the App on the clean file and wait for the canvas to open. */
async function renderClean(extra: Parameters<typeof stubClient>[0] = {}, calls?: StubCalls) {
  const client = stubClient({ files: { [ROOT_PATH]: JSON.stringify(cleanFile()) }, calls, ...extra });
  render(<App client={client} initialPath={ROOT_PATH} />);
  await screen.findByRole("region", { name: "Workflow canvas" });
  return client;
}

describe("Designer run surfaces (#372)", () => {
  it("launch is enabled on a clean buffer and runs the open file's path", async () => {
    const calls = makeCalls();
    await renderClean({}, calls);
    openDock();

    const submit = screen.getByTestId("run-launch-submit");
    expect(submit).toBeEnabled();
    expect(screen.queryByTestId("run-launch-gate")).not.toBeInTheDocument();

    fireEvent.click(submit);
    await waitFor(() => expect(calls.startRun).toHaveLength(1));
    expect(calls.startRun[0]!.workflow_path).toBe(ROOT_PATH);
    // The prefilled `{}` input rides the launch; no config override was set.
    expect(calls.startRun[0]!.input).toEqual({});
    expect(calls.startRun[0]!.config).toBeUndefined();
  });

  it("launch is disabled while the buffer is dirty, and says why", async () => {
    const client = stubClient({ files: { [ROOT_PATH]: JSON.stringify(dirtyFile()) } });
    render(<App client={client} initialPath={ROOT_PATH} />);
    await screen.findByRole("region", { name: "Workflow canvas" });
    openDock();

    expect(screen.getByTestId("run-launch-submit")).toBeDisabled();
    expect(screen.getByTestId("run-launch-gate")).toHaveTextContent(/save/i);
  });

  it("a launch 400 surfaces on the form without collapsing it", async () => {
    await renderClean({
      onStartRun: () => new Response(JSON.stringify({ error: { message: "rejected $env override" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
    });
    openDock();

    fireEvent.click(screen.getByTestId("run-launch-submit"));
    const error = await screen.findByTestId("run-launch-error");
    expect(error).toHaveTextContent("rejected $env override");
    // The form did not collapse — the input field is still there to fix and retry.
    expect(screen.getByTestId("run-launch-input")).toBeInTheDocument();
  });

  it("scopes the run list to the open workflow by workflow_id", async () => {
    const calls = makeCalls();
    await renderClean({ runs: { runs: [] } }, calls);
    openDock();

    await waitFor(() => expect(calls.listRuns.length).toBeGreaterThan(0));
    expect(calls.listRuns.every((qs) => qs.includes(`workflow_id=${encodeURIComponent(WF_ID)}`))).toBe(true);
  });

  it("cancel uses arm-then-confirm on a run in flight", async () => {
    const calls = makeCalls();
    await renderClean(
      {
        runs: { runs: [{ run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status: "running", started_at: "2026-01-01T00:00:00Z", finished_at: null }] },
        tree: { root_run_id: "root-1", status: "running", output: null, runs: [wireRun({ run_id: "root-1", status: "running" })] },
      },
      calls,
    );
    openDock();

    fireEvent.click(await screen.findByTestId("run-row-root-1"));
    const cancel = await screen.findByTestId("run-cancel");
    expect(cancel).toHaveTextContent("Cancel run");

    fireEvent.click(cancel); // arm
    expect(cancel).toHaveTextContent("Confirm cancel?");
    expect(calls.cancel).toHaveLength(0);

    fireEvent.click(cancel); // confirm
    await waitFor(() => expect(calls.cancel).toEqual(["root-1"]));
  });

  it("resume offers the config-override form and shows the plan-reuse caveat", async () => {
    await renderClean({
      runs: { runs: [{ run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status: "failed", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z" }] },
      tree: { root_run_id: "root-1", status: "failed", output: null, runs: [wireRun({ run_id: "root-1", status: "failed" })] },
    });
    openDock();

    fireEvent.click(await screen.findByTestId("run-row-root-1"));
    expect(await screen.findByTestId("run-resume-caveat")).toHaveTextContent(/previous/i);
    expect(screen.getByTestId("run-resume-submit")).toBeInTheDocument();
    // The config override is behind a disclosure (empty by default) — open it to reveal the field.
    fireEvent.click(screen.getByTestId("run-resume-config-toggle"));
    expect(screen.getByTestId("run-resume-config")).toBeInTheDocument();
  });

  it("projects run status onto the matching canvas node", async () => {
    await renderClean({
      runs: { runs: [{ run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status: "running", started_at: "2026-01-01T00:00:00Z", finished_at: null }] },
      tree: {
        root_run_id: "root-1",
        status: "running",
        output: null,
        runs: [wireRun({ run_id: "root-1", status: "running" }), wireRun({ run_id: "r-step", status: "running", node_id: STEP_ID, node_name: "draft" })],
      },
    });
    openDock();

    fireEvent.click(await screen.findByTestId("run-row-root-1"));
    const badge = await screen.findByTestId(`node-run-badge-${STEP_ID}`);
    expect(badge).toHaveAttribute("data-run-status", "running");
  });

  it("shows a selected run's node I/O, and the shared absence rule for a missing terminal output", async () => {
    await renderClean({
      runs: { runs: [{ run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status: "succeeded", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z" }] },
      tree: {
        root_run_id: "root-1",
        status: "succeeded",
        output: null,
        runs: [wireRun({ run_id: "root-1", status: "succeeded" }), wireRun({ run_id: "r-step", status: "succeeded", node_id: STEP_ID, node_name: "draft" })],
      },
      blobs: { "r-step/input": { seed: 1 } },
    });
    openDock();

    fireEvent.click(await screen.findByTestId("run-row-root-1"));
    fireEvent.click(await screen.findByTestId("run-tree-row-r-step"));

    // Input present → rendered; output absent on a terminal run → the "no output recorded" note (the
    // read-anyway-and-trust-the-404 branch of the shared absence rule, #51).
    const io = await screen.findByTestId("run-node-io");
    await waitFor(() => expect(within(screen.getByTestId("run-node-io-input")).queryByText(/seed/)).toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByTestId("run-node-io-output")).getByText(/No output object recorded/i)).toBeInTheDocument());
    expect(io).toBeInTheDocument();
  });
});
