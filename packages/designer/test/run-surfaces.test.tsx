import { FORMAT_VERSION, type WireStepPlugin } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { DEFAULT_PLUGINS, makeCalls, stubClient, type StubCalls } from "./stub-server.js";

/**
 * The on-disk bytes of a file the Designer has already saved: canonical, so a re-open is a fixed point
 * and reads **clean** (ADR 0030). A raw `JSON.stringify` of a fixture is *not* canonical (whitespace and
 * parse-time key order differ), so it would open dirty — this models what production files look like.
 */
function canonicalBytes(file: Record<string, unknown>): string {
  const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);
  if (result.status !== "opened") throw new Error(`fixture did not open: ${result.status}`);
  return canonicalSerialize(result.file);
}

/** A distinct valid UUIDv4 per seed, so fixtures read as ids without a random source. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const ROOT_PATH = "flows/main.workflow.json";
const WF_ID = uuid(1);
const STEP_ID = uuid(2);
const OTHER_PATH = "flows/other.workflow.json";
const OTHER_WF_ID = uuid(9);

/** A clean, fully-id'd root file — opens without a stamp, so the buffer is clean and launch is enabled. */
function cleanFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: WF_ID,
    name: "root-flow",
    body: [{ type: "prompt", id: STEP_ID, name: "draft", prompt: "hi" }],
  };
}

/** A second clean root, a workflow that was never run — its own id, so opening it re-scopes the dock. */
function otherFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: OTHER_WF_ID,
    name: "other-flow",
    body: [{ type: "prompt", id: uuid(10), name: "draft", prompt: "hi" }],
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
  const client = stubClient({ files: { [ROOT_PATH]: canonicalBytes(cleanFile()) }, calls, ...extra });
  render(<App client={client} initialPath={ROOT_PATH} />);
  await screen.findByRole("region", { name: "Workflow canvas" });
  return client;
}

/**
 * A registry shaped like the shipped one: `prompt` declares **two** workers, `anthropic` (default) and
 * `deepseek` (`packages/engine/plugin/step-plugin/prompt/index.ts`), so a worker-default has one to select
 * (ADR 0044). `DEFAULT_PLUGINS` is the stub's single-worker stand-in, not the real registry.
 */
const MULTI_WORKER_PLUGINS: WireStepPlugin[] = DEFAULT_PLUGINS.map((plugin) =>
  plugin.name === "prompt" ? { ...plugin, workers: ["anthropic", "deepseek"] } : plugin,
);

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
    // No input override was typed, so the field is omitted — the server falls back to the file's own
    // `input` seed (else `{}`); no config override was set either.
    expect(calls.startRun[0]!.input).toBeUndefined();
    expect(calls.startRun[0]!.config).toBeUndefined();
  });

  it("offers the launch worker-default table, and posts it with the run", async () => {
    const calls = makeCalls();
    await renderClean({ plugins: MULTI_WORKER_PLUGINS }, calls);
    openDock();

    // The dock launches a run, so it carries the same operator door the Viewer's launch panel does.
    fireEvent.click(await screen.findByTestId("run-launch-worker-defaults-toggle"));
    fireEvent.click(screen.getByTestId("worker-default-add"));
    expect((screen.getByLabelText("type") as HTMLSelectElement).value).toBe("prompt");
    fireEvent.change(screen.getByLabelText("worker"), { target: { value: "deepseek" } });

    fireEvent.click(screen.getByTestId("run-launch-submit"));
    await waitFor(() => expect(calls.startRun).toHaveLength(1));
    expect(calls.startRun[0]!.worker_defaults).toEqual({ prompt: "deepseek" });
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

    fireEvent.click(screen.getByTestId("run-launch-input-toggle"));
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
    const cancel = await screen.findByTestId("cancel-button");
    expect(cancel).toHaveTextContent("Cancel run");

    fireEvent.click(cancel); // arm
    expect(cancel).toHaveTextContent("Confirm cancel?");
    expect(calls.cancel).toHaveLength(0);

    fireEvent.click(cancel); // confirm
    await waitFor(() => expect(calls.cancel).toEqual(["root-1"]));
  });

  it("resume offers the config-override form", async () => {
    await renderClean({
      runs: { runs: [{ run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status: "failed", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z" }] },
      tree: { root_run_id: "root-1", status: "failed", output: null, runs: [wireRun({ run_id: "root-1", status: "failed" })] },
    });
    openDock();

    fireEvent.click(await screen.findByTestId("run-row-root-1"));
    expect(await screen.findByTestId("resume-button")).toBeInTheDocument();
    // The config override is behind a disclosure (empty by default) — open it to reveal the field.
    fireEvent.click(screen.getByTestId("resume-config-toggle"));
    expect(screen.getByTestId("resume-config")).toBeInTheDocument();
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

  it("badges the workflow-name line with the root run's status", async () => {
    // The root run carries no node_id, so it projects onto no canvas node; its verdict shows on the
    // breadcrumb's workflow-name line instead.
    await renderClean({
      runs: { runs: [{ run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status: "succeeded", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z" }] },
      tree: {
        root_run_id: "root-1",
        status: "succeeded",
        output: null,
        runs: [wireRun({ run_id: "root-1", status: "succeeded" })],
      },
    });
    // No run watched yet — the workflow-name line carries no badge.
    expect(screen.queryByTestId("workflow-run-badge")).not.toBeInTheDocument();

    openDock();
    fireEvent.click(await screen.findByTestId("run-row-root-1"));

    const badge = await screen.findByTestId("workflow-run-badge");
    expect(badge).toHaveAttribute("data-run-status", "succeeded");
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
    fireEvent.click(await screen.findByTestId("tree-row-r-step"));

    // Input present → rendered; output absent on a terminal run → the "no output recorded" note (the
    // read-anyway-and-trust-the-404 branch of the shared absence rule, #51).
    const io = await screen.findByTestId("node-io-head");
    await waitFor(() => expect(within(screen.getByTestId("node-io-input")).queryByText(/seed/)).toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByTestId("node-io-output")).getByText(/No output object recorded/i)).toBeInTheDocument());
    expect(io).toBeInTheDocument();
  });

  it("drops the watched run when a different workflow is opened", async () => {
    // Open the root file, watch its succeeded run, then open a *different* workflow that was never run. The
    // watched run belongs to the old workflow, so it must not survive the re-scope: the run-detail pane
    // clears and the new workflow's breadcrumb carries no status badge (the reported bug).
    const client = stubClient({
      files: { [ROOT_PATH]: canonicalBytes(cleanFile()), [OTHER_PATH]: canonicalBytes(otherFile()) },
      workflows: {
        workflows: [
          { relative_path: ROOT_PATH, id: WF_ID, name: "root-flow", valid: true, is_root: true, error: null },
          { relative_path: OTHER_PATH, id: OTHER_WF_ID, name: "other-flow", valid: true, is_root: true, error: null },
        ],
      },
      runs: { runs: [{ run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status: "succeeded", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z" }] },
      tree: { root_run_id: "root-1", status: "succeeded", output: null, runs: [wireRun({ run_id: "root-1", status: "succeeded" })] },
    });
    render(<App client={client} initialPath={ROOT_PATH} />);
    await screen.findByRole("region", { name: "Workflow canvas" });
    openDock();

    // Watch the succeeded run: the badge lights and the run-detail pane shows the tree, not its empty note.
    fireEvent.click(await screen.findByTestId("run-row-root-1"));
    expect(await screen.findByTestId("workflow-run-badge")).toHaveAttribute("data-run-status", "succeeded");
    expect(screen.queryByText("Select a run.")).not.toBeInTheDocument();

    // Open the never-run workflow through the picker (the files sit under a `flows/` folder).
    fireEvent.click(screen.getByText("Open…"));
    fireEvent.click(await screen.findByText("flows"));
    fireEvent.click(await screen.findByText("other.workflow.json"));

    // The new workflow's name renders on the breadcrumb — with no run badge, because it never ran.
    await screen.findByText("other-flow");
    await waitFor(() => expect(screen.queryByTestId("workflow-run-badge")).not.toBeInTheDocument());
    // The run-detail pane fell back to its empty note; the old run's detail is gone.
    expect(screen.getByText("Select a run.")).toBeInTheDocument();
  });
});

/**
 * #487 / ADR 0031: the Designer run dock reuses the Viewer's awaiting surfaces. The dock feeds the open
 * buffer to `RunDetail`/`NodeIo` as their `rootFile`, so an awaiting `person-activity` leaf reads the
 * same assignee chip in the rail and the same schema-built inline Complete form the Viewer draws — no
 * Designer fork. This test would fail if the dock stopped threading `rootFile` (the surface would degrade
 * to the schema-less fallback, showing `awaiting-unresolved`).
 */
describe("Designer run dock reuses the Viewer awaiting/Complete surfaces (#487, ADR 0031)", () => {
  const PERSON_PLUGINS: WireStepPlugin[] = [
    ...DEFAULT_PLUGINS,
    {
      name: "person-activity",
      fields: {
        description: { type: "string", optional: false },
        outputSchema: { type: "object", optional: true },
        assignee: { type: "string", optional: true },
      },
      workers: ["person"],
      default_worker: "person",
    },
  ];

  /** A root file whose only step is an awaiting-capable `person-activity` leaf at `STEP_ID`. */
  function awaitingFile(): Record<string, unknown> {
    return {
      format: FORMAT_VERSION,
      id: WF_ID,
      name: "root-flow",
      body: [
        {
          type: "person-activity",
          id: STEP_ID,
          name: "review",
          description: "Review the draft",
          outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
          assignee: "editor",
        },
      ],
    };
  }

  function canonicalWith(file: Record<string, unknown>, plugins: WireStepPlugin[]): string {
    const result = openWorkflowFile(JSON.stringify(file), plugins);
    if (result.status !== "opened") throw new Error(`fixture did not open: ${result.status}`);
    return canonicalSerialize(result.file);
  }

  async function renderAwaiting() {
    const client = stubClient({
      files: { [ROOT_PATH]: canonicalWith(awaitingFile(), PERSON_PLUGINS) },
      plugins: PERSON_PLUGINS,
      runs: { runs: [{ run_id: "root-1", workflow_name: "root-flow", workflow_id: WF_ID, workflow_path: ROOT_PATH, status: "running", started_at: "2026-01-01T00:00:00Z", finished_at: null }] },
      tree: {
        root_run_id: "root-1",
        status: "running",
        output: null,
        // The root stays running while the leaf awaits (ADR 0038).
        runs: [wireRun({ run_id: "root-1", status: "running" }), wireRun({ run_id: "r-step", status: "awaiting", node_id: STEP_ID, node_name: "review" })],
      },
    });
    render(<App client={client} initialPath={ROOT_PATH} />);
    await screen.findByRole("region", { name: "Workflow canvas" });
    openDock();
    fireEvent.click(await screen.findByTestId("run-row-root-1"));
  }

  it("shows the awaiting pill and the assignee chip in the run rail", async () => {
    await renderAwaiting();
    const row = await screen.findByTestId("tree-row-r-step");
    // ⏳ purple awaiting pill (the pill's label is the status) + the informational assignee chip.
    expect(within(row).getByText("awaiting")).toBeInTheDocument();
    expect(within(row).getByTestId("assignee-chip")).toHaveTextContent("editor");
  });

  it("badges the canvas breadcrumb `awaiting`, not `running`, while a leaf is parked (ADR 0038)", async () => {
    await renderAwaiting();
    // The root record stays `running`, but the breadcrumb reads the shared display status, so it agrees
    // with the run rail: a running root with an awaiting leaf below reads `awaiting`.
    const badge = await screen.findByTestId("workflow-run-badge");
    expect(badge).toHaveAttribute("data-run-status", "awaiting");
  });

  it("mounts the Viewer's inline Complete form, built from the node's outputSchema (not the schema-less fallback)", async () => {
    await renderAwaiting();
    fireEvent.click(await screen.findByTestId("tree-row-r-step"));

    // The detail-panel awaiting surface resolves the node from the open buffer (rootFile), so it is the
    // real form, never the degraded "could not read this step's form" note.
    const actions = within(await screen.findByTestId("awaiting-actions"));
    expect(screen.queryByTestId("awaiting-unresolved")).not.toBeInTheDocument();
    expect(actions.getByTestId("awaiting-description")).toHaveTextContent("Review the draft");

    // The form is inline in the panel (no slide-over to open). The `approved` control proves it was
    // built from `outputSchema`, matching the Viewer.
    expect(actions.getByTestId("complete-form")).toBeInTheDocument();
    expect(actions.getByTestId("complete-field-approved")).toBeInTheDocument();
  });
});
