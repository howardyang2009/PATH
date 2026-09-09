import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { DEFAULT_PLUGINS, makeCalls, stubClient, type DesignerStubOptions, type StubCalls } from "./stub-server.js";

/** Canonical on-disk bytes, so a re-open reads clean (ADR 0030) — the same helper the run-surfaces test uses. */
function canonicalBytes(file: Record<string, unknown>): string {
  const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);
  if (result.status !== "opened") throw new Error(`fixture did not open: ${result.status}`);
  return canonicalSerialize(result.file);
}

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const ROOT_PATH = "flows/main.workflow.json";
const WF_ID = uuid(1);
const STEP1_ID = uuid(2);
const STEP2_ID = uuid(3);

/** A clean, fully-id'd two-step root: `draft` then `review`, so `review` is a legal K with `draft` before it. */
function twoStepFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: WF_ID,
    name: "root-flow",
    body: [
      { type: "prompt", id: STEP1_ID, name: "draft", prompt: "hi" },
      { type: "prompt", id: STEP2_ID, name: "review", prompt: "hi" },
    ],
  };
}

/** A run row carrying the fields the tree + the eager legal-K check read; the rest are inert nulls. */
function wireRun(p: { run_id: string; status: string; node_id?: string | null; node_name?: string | null }): Record<string, unknown> {
  return {
    run_id: p.run_id,
    root_run_id: "root-1",
    parent_run_id: p.run_id === "root-1" ? null : "root-1",
    node_id: p.node_id ?? null,
    node_name: p.node_name ?? null,
    worker_name: null,
    status: p.status,
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:01:00Z",
    input_ref: null,
    output_ref: null,
    usage: null,
    estimated_cost_usd: null,
    resumed_from_root_run_id: null,
    reused_from_run_id: null,
    reused_from_root_run_id: null,
    workflow_id: p.run_id === "root-1" ? WF_ID : null,
    workflow_name: p.run_id === "root-1" ? "root-flow" : null,
    workflow_path: p.run_id === "root-1" ? ROOT_PATH : null,
  };
}

/** A root-run summary row for the rail, at the given status. */
function summary(status: string): Record<string, unknown> {
  return { run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status, started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z" };
}

function openDock(): void {
  fireEvent.click(screen.getByTestId("run-dock-toggle"));
}

/** Render the App on the two-step file with the given rail + tree, then open the dock and watch root-1. */
async function renderWatching(
  opts: { rootStatus: string; treeRuns: Record<string, unknown>[]; onResumeRun?: DesignerStubOptions["onResumeRun"] },
  calls?: StubCalls,
) {
  const client = stubClient({
    files: { [ROOT_PATH]: canonicalBytes(twoStepFile()) },
    runs: { runs: [summary(opts.rootStatus)] },
    tree: { root_run_id: "root-1", status: opts.rootStatus, output: null, runs: opts.treeRuns },
    onResumeRun: opts.onResumeRun,
    calls,
  });
  render(<App client={client} initialPath={ROOT_PATH} />);
  await screen.findByRole("region", { name: "Workflow canvas" });
  openDock();
  fireEvent.click(await screen.findByTestId("run-row-root-1"));
  return client;
}

describe("Designer Resume-from-K button (#447)", () => {
  it("is rendered but disabled with the select-a-node reason when no tree row is selected", async () => {
    await renderWatching({
      rootStatus: "failed",
      treeRuns: [wireRun({ run_id: "root-1", status: "failed" }), wireRun({ run_id: "r-step1", status: "failed", node_id: STEP1_ID, node_name: "draft" })],
    });

    const submit = await screen.findByTestId("resume-from-submit");
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent("Resume from …");
    expect(screen.getByTestId("resume-from-reason")).toHaveTextContent("Select a node in the run tree.");
  });

  it("enables on a legal K and sends its run id as rerun_from_run_id", async () => {
    const calls = makeCalls();
    await renderWatching(
      {
        rootStatus: "failed",
        treeRuns: [
          wireRun({ run_id: "root-1", status: "failed" }),
          wireRun({ run_id: "r-step1", status: "succeeded", node_id: STEP1_ID, node_name: "draft" }),
          wireRun({ run_id: "r-step2", status: "succeeded", node_id: STEP2_ID, node_name: "review" }),
        ],
      },
      calls,
    );

    fireEvent.click(await screen.findByTestId("tree-row-r-step2"));
    const submit = await screen.findByTestId("resume-from-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    // Once a legal K is selected the label carries its identity; the full run id is the hover title.
    expect(submit).toHaveTextContent("Resume from review(r-step2)");
    expect(submit).toHaveAttribute("title", "Resume from review (r-step2)");
    expect(screen.queryByTestId("resume-from-reason")).not.toBeInTheDocument();

    fireEvent.click(submit);
    await waitFor(() => expect(calls.resume).toHaveLength(1));
    expect(calls.resume[0]!.rootRunId).toBe("root-1");
    expect(calls.resume[0]!.body).toMatchObject({ rerun_from_run_id: "r-step2" });
  });

  it("greys an illegal K (prefix not succeeded) with the taxonomy reason", async () => {
    await renderWatching({
      rootStatus: "failed",
      treeRuns: [
        wireRun({ run_id: "root-1", status: "failed" }),
        wireRun({ run_id: "r-step1", status: "failed", node_id: STEP1_ID, node_name: "draft" }),
        wireRun({ run_id: "r-step2", status: "succeeded", node_id: STEP2_ID, node_name: "review" }),
      ],
    });

    fireEvent.click(await screen.findByTestId("tree-row-r-step2"));
    const submit = await screen.findByTestId("resume-from-submit");
    await waitFor(() => expect(screen.getByTestId("resume-from-reason")).toHaveTextContent(/prefix must succeed/i));
    expect(submit).toBeDisabled();
  });

  it("surfaces a server-side legal-K refusal (the race) as an error, without collapsing", async () => {
    await renderWatching({
      rootStatus: "failed",
      treeRuns: [
        wireRun({ run_id: "root-1", status: "failed" }),
        wireRun({ run_id: "r-step1", status: "succeeded", node_id: STEP1_ID, node_name: "draft" }),
        wireRun({ run_id: "r-step2", status: "succeeded", node_id: STEP2_ID, node_name: "review" }),
      ],
      onResumeRun: () => new Response(JSON.stringify({ error: { message: "run resolves to node which is no longer in the workflow" } }), { status: 409, headers: { "Content-Type": "application/json" } }),
    });

    fireEvent.click(await screen.findByTestId("tree-row-r-step2"));
    fireEvent.click(await screen.findByTestId("resume-from-submit"));
    expect(await screen.findByTestId("resume-from-error")).toHaveTextContent("no longer in the workflow");
    // The button is still there to read the reason and retry — the form did not collapse.
    expect(screen.getByTestId("resume-from-submit")).toBeInTheDocument();
  });

  it("a succeeded root run offers Resume from … as its resume path, plain Resume greyed", async () => {
    await renderWatching({
      rootStatus: "succeeded",
      treeRuns: [
        wireRun({ run_id: "root-1", status: "succeeded" }),
        wireRun({ run_id: "r-step1", status: "succeeded", node_id: STEP1_ID, node_name: "draft" }),
        wireRun({ run_id: "r-step2", status: "succeeded", node_id: STEP2_ID, node_name: "review" }),
      ],
    });

    // On a succeeded run plain Resume (cancelled/failed only) is greyed but kept, not hidden; the live
    // resume path is Resume from …, which stands alongside it.
    expect(await screen.findByTestId("resume-button")).toBeDisabled();
    expect(await screen.findByTestId("resume-from-submit")).toBeInTheDocument();

    // Selecting a legal K enables it — the succeeded root's one way back in.
    fireEvent.click(await screen.findByTestId("tree-row-r-step2"));
    await waitFor(() => expect(screen.getByTestId("resume-from-submit")).toBeEnabled());
  });
});
