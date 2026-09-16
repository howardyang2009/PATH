import type { PathApiClient, RunNodeState, WorkflowFile } from "@path/client-core";
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
  format: "path/workflow@3",
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
  ] as unknown as WorkflowFile["body"],
} satisfies WorkflowFile;

function ConnectedDetail({ client }: { client: PathApiClient }) {
  const load = useRunView(client, ROOT);
  return <RunDetail client={client} load={load} rootRunId={ROOT} selectedRunId={null} onSelectRun={vi.fn()} rootFile={ROOT_FILE} />;
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
});

describe("awaiting detail panel + Complete slide-over (NodeIo)", () => {
  it("shows the description callout and a Complete button for an awaiting leaf", async () => {
    render(<NodeIo client={stubClient()} run={runState()} rootFile={ROOT_FILE} />);

    expect(screen.getByTestId("awaiting-description")).toHaveTextContent("Review the contract for {{client.name}}.");
    expect(screen.getByTestId("awaiting-complete-button")).toBeInTheDocument();
    // The detail-panel surface is scoped to the leaf; the assignee shows here too.
    expect(within(screen.getByTestId("awaiting-actions")).getByTestId("assignee-chip")).toHaveTextContent("legal@acme.co");
  });

  it("opens the slide-over form built from the outputSchema, and completes on submit", async () => {
    const completeBodies: unknown[] = [];
    const client = stubClient({ completeBodies });
    render(<NodeIo client={client} run={runState()} rootFile={ROOT_FILE} />);

    fireEvent.click(screen.getByTestId("awaiting-complete-button"));
    const panel = screen.getByTestId("complete-slide-over");
    expect(within(panel).getByTestId("complete-field-approved")).toBeInTheDocument();

    fireEvent.click(within(panel).getByLabelText(/Approved/));
    fireEvent.click(within(panel).getByTestId("complete-submit"));

    await waitFor(() => expect(screen.queryByTestId("complete-slide-over")).toBeNull());
    expect(completeBodies[0]).toEqual({ output: { approved: true } });
  });

  it("keeps the slide-over open with field errors on a 400 (leaf stays awaiting)", async () => {
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
    render(<NodeIo client={client} run={runState()} rootFile={ROOT_FILE} />);

    fireEvent.click(screen.getByTestId("awaiting-complete-button"));
    // Submitting an unchecked box coerces to `approved: false`, which is present client-side but the
    // server's required check here rejects — the point is the 400 field error renders and the panel stays.
    fireEvent.click(within(screen.getByTestId("complete-slide-over")).getByTestId("complete-submit"));

    await waitFor(() =>
      expect(within(screen.getByTestId("complete-slide-over")).getByTestId("complete-field-approved")).toHaveTextContent(
        "must have required property 'approved'",
      ),
    );
  });

  it("degrades to a schema-less submit when the node is not in the file", () => {
    render(<NodeIo client={stubClient()} run={runState({ nodeId: "step-nested" })} rootFile={ROOT_FILE} />);
    expect(screen.getByTestId("awaiting-unresolved")).toBeInTheDocument();
    expect(screen.getByTestId("awaiting-complete-button")).toBeInTheDocument();
  });
});
