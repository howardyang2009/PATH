import { displayStatusByRun, type PathApiClient, type RunNodeState, type WorkflowFile } from "@path/client-core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeIo } from "../src/node-io.js";
import { RunDetail } from "../src/run-detail.js";
import { useRunView } from "../src/use-run-view.js";
import { stubClient } from "./stub-server.js";

const ROOT = "run_root";

function record(overrides: Record<string, unknown>) {
  return {
    run_id: "run_x",
    root_run_id: ROOT,
    parent_run_id: ROOT,
    node_id: "step-x",
    node_name: null,
    worker_name: null,
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

/** Root `running` (never awaits — ADR 0038); two awaiting person leaves + one pending. */
const TREE = {
  root_run_id: ROOT,
  status: "running",
  output: null,
  runs: [
    record({ run_id: ROOT, parent_run_id: null, node_id: null, status: "running", started_at: "2026-07-25T10:00:00.000Z" }),
    record({ run_id: "run_legal", node_id: "step-legal", node_name: "legal-signoff", status: "awaiting" }),
    record({ run_id: "run_finance", node_id: "step-finance", node_name: "finance-approval", status: "awaiting" }),
    record({ run_id: "run_send", node_id: "step-send", node_name: "send", status: "pending" }),
  ],
};

const ROOT_FILE = {
  format: "path/workflow@4",
  id: "wf",
  name: "onboarding",
  body: [
    {
      id: "step-legal",
      type: "person-activity",
      name: "legal-signoff",
      description: "Review the contract for {{client.name}}.",
      assignee: "legal@acme.co",
      outputSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean", title: "Approved" } } },
    },
    { id: "step-finance", type: "person-activity", name: "finance-approval", description: "Approve the budget.", assignee: "cfo@acme.co" },
    // A `workflow` step whose ref'd file holds a further person-activity leaf; the run tree carries
    // only that leaf's node id, so its fields are resolved from the sub-file, not this one.
    { id: "step-sub", type: "workflow", name: "sub", ref: "sub.workflow.json" },
  ] as unknown as WorkflowFile["body"],
} satisfies WorkflowFile;

/** The ref'd sub-workflow file: it defines the nested awaiting node `step-nested`. */
const SUB_FILE = {
  format: "path/workflow@4",
  id: "wf-sub",
  name: "sub",
  body: [
    {
      id: "step-nested",
      type: "person-activity",
      name: "nested-review",
      description: "Nested review for {{client.name}}.",
      assignee: "ops@acme.co",
      outputSchema: { type: "object", required: ["done"], properties: { done: { type: "boolean", title: "Done" } } },
    },
  ] as unknown as WorkflowFile["body"],
} satisfies WorkflowFile;

function ConnectedDetail({ client }: { client: PathApiClient }) {
  const load = useRunView(client, ROOT);
  return <RunDetail client={client} load={load} rootRunId={ROOT} selectedRunId={null} onSelectRun={vi.fn()} workflowFiles={[ROOT_FILE]} />;
}

/** One run as the tree hands it to the node pane. */
function runState(overrides: Partial<RunNodeState> = {}): RunNodeState {
  return {
    runId: "run_legal",
    rootRunId: ROOT,
    parentRunId: ROOT,
    nodeId: "step-legal",
    nodeName: "legal-signoff",
    workerName: null,
    iteration: null,
    status: "awaiting",
    startedAt: "2026-07-25T10:00:00.000Z",
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    rerunFromNodePath: null,
    reusedFromRunId: null,
    reusedFromRootRunId: null,
    workflowId: null,
    workflowName: null,
    workflowPath: null,
    ...overrides,
  };
}

describe("awaiting rail (RunDetail)", () => {
  it("shows the awaiting pill and the assignee chip on an awaiting leaf", async () => {
    render(<ConnectedDetail client={stubClient({ tree: TREE })} />);

    const row = await screen.findByTestId("tree-item-run_legal");
    expect(within(row).getByText("awaiting")).toBeInTheDocument();
    expect(within(row).getByTestId("assignee-chip")).toHaveTextContent("legal@acme.co");
  });

  it("carries a count badge when several leaves await (parallel joins, ADR 0042)", async () => {
    render(<ConnectedDetail client={stubClient({ tree: TREE })} />);
    expect(await screen.findByTestId("awaiting-count-badge")).toHaveTextContent("2 awaiting");
  });

  it("shows no count badge when only one leaf awaits", async () => {
    const single = { ...TREE, runs: TREE.runs.map((r) => (r.run_id === "run_finance" ? { ...r, status: "pending" } : r)) };
    render(<ConnectedDetail client={stubClient({ tree: single })} />);
    await screen.findByTestId("tree-item-run_legal");
    expect(screen.queryByTestId("awaiting-count-badge")).toBeNull();
  });

  it("shows awaiting in the run-detail head when a descendant leaf awaits (root stays running in record)", async () => {
    render(<ConnectedDetail client={stubClient({ tree: TREE })} />);
    const head = await screen.findByTestId("run-head");
    // The root's record status is running (ADR 0038); the head reads awaiting through the shared
    // derivation, matching the rail's root row.
    expect(within(head).getByText("awaiting")).toBeInTheDocument();
  });
});

describe("awaiting detail panel — inline Complete (NodeIo)", () => {
  it("shows the description callout, the assignee, and the inline Complete form for an awaiting leaf", async () => {
    render(<NodeIo client={stubClient()} run={runState()} workflowFiles={[ROOT_FILE]} />);

    expect(screen.getByTestId("awaiting-description")).toHaveTextContent("Review the contract for {{client.name}}.");
    // The form is inline in the panel — no button to open a slide-over first.
    const actions = within(screen.getByTestId("awaiting-actions"));
    expect(actions.getByTestId("complete-form")).toBeInTheDocument();
    expect(actions.getByTestId("complete-field-approved")).toBeInTheDocument();
    expect(actions.getByTestId("assignee-chip")).toHaveTextContent("legal@acme.co");
    // The submit button carries the panel's own label.
    expect(actions.getByTestId("complete-submit")).toHaveTextContent("Complete this activity");
  });

  it("resolves an awaiting leaf living in a nested sub-workflow file, not only the root", async () => {
    // The leaf's node id (step-nested) is defined in SUB_FILE, reached from the root through a
    // `workflow` step. The app hands the whole reachable set, so the surface resolves it there — the
    // same content as a root leaf: description, assignee, output schema, and the Complete form.
    const nested = runState({ runId: "run_nested", nodeId: "step-nested", nodeName: "nested-review" });
    render(<NodeIo client={stubClient()} run={nested} workflowFiles={[ROOT_FILE, SUB_FILE]} />);

    expect(screen.getByTestId("awaiting-description")).toHaveTextContent("Nested review for {{client.name}}.");
    const actions = within(screen.getByTestId("awaiting-actions"));
    expect(actions.getByTestId("assignee-chip")).toHaveTextContent("ops@acme.co");
    expect(actions.getByTestId("complete-field-done")).toBeInTheDocument();
    expect(actions.getByTestId("complete-submit")).toHaveTextContent("Complete this activity");
    // No "form could not be read" degradation note — the node resolved.
    expect(screen.queryByTestId("awaiting-unresolved")).toBeNull();
  });

  it("shows the output schema, and completes inline on submit", async () => {
    const completeBodies: unknown[] = [];
    const client = stubClient({ completeBodies });
    render(<NodeIo client={client} run={runState()} workflowFiles={[ROOT_FILE]} />);

    // The step's outputSchema shows in the panel (the `approved` property is in the rendered JSON).
    expect(screen.getByTestId("awaiting-output-schema")).toHaveTextContent("approved");

    fireEvent.click(screen.getByLabelText(/Approved/));
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(completeBodies[0]).toEqual({ output: { approved: true } }));
  });

  it("keeps the inline form with field errors on a 400 (leaf stays awaiting)", async () => {
    const client = stubClient({
      complete: {
        status: 400,
        body: {
          error: {
            message: "output does not match the step's outputSchema",
            details: [{ instancePath: "", keyword: "required", params: { missingProperty: "approved" }, message: "must have required property 'approved'" }],
          },
        },
      },
    });
    render(<NodeIo client={client} run={runState()} workflowFiles={[ROOT_FILE]} />);

    // Submitting an unchecked box coerces to `approved: false`, which is present client-side but the
    // server's required check here rejects — the point is the 400 field error renders in place.
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("complete-field-approved")).toHaveTextContent("must have required property 'approved'"),
    );
  });

  it("shows an empty output schema and a raw-JSON control for a node with no outputSchema", () => {
    render(<NodeIo client={stubClient()} run={runState({ runId: "run_finance", nodeId: "step-finance", nodeName: "finance-approval" })} workflowFiles={[ROOT_FILE]} />);

    // The schema block is a fixed slot: it shows even when the node authored none.
    expect(screen.getByTestId("awaiting-output-schema")).toBeInTheDocument();
    expect(screen.getByTestId("awaiting-output-schema-empty")).toBeInTheDocument();
    // With no schema the person still gets somewhere to enter the output.
    expect(screen.getByTestId("complete-raw-output")).toBeInTheDocument();
  });

  it("degrades to a schema-less submit when the node is in no loaded file (the sub-file failed to read)", () => {
    // step-nested lives in SUB_FILE; with only the root loaded (a since-moved or unreadable ref) the
    // reachable set cannot resolve it, so the surface degrades rather than inventing a form.
    render(<NodeIo client={stubClient()} run={runState({ nodeId: "step-nested" })} workflowFiles={[ROOT_FILE]} />);
    expect(screen.getByTestId("awaiting-unresolved")).toBeInTheDocument();
    expect(screen.getByTestId("complete-raw-output")).toBeInTheDocument();
    expect(screen.getByTestId("complete-submit")).toBeInTheDocument();
  });

  it("shows awaiting in the node I/O head for a running run with an awaiting descendant, but no Complete form", () => {
    const runs = new Map<string, RunNodeState>([
      ["run_root", runState({ runId: "run_root", parentRunId: null, nodeId: null, nodeName: null, status: "running" })],
      ["run_legal", runState()],
    ]);
    // The view publishes the derived fact (the shared derivation, exercised here through the real
    // function); the pane only renders what it is given.
    const view = { displayStatus: displayStatusByRun(runs), lastError: new Map<string, string>() };
    render(<NodeIo client={stubClient()} run={runs.get("run_root")!} view={view} workflowFiles={[ROOT_FILE]} />);

    // The head reads awaiting (shared derivation), yet the running root is not itself awaiting, so it
    // gets no Complete surface — that stays keyed on the real status.
    expect(within(screen.getByTestId("node-io-head")).getByText("awaiting")).toBeInTheDocument();
    expect(screen.queryByTestId("awaiting-actions")).toBeNull();
  });
});
