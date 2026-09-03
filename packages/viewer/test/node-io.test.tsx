import type { LogEvent, RunNodeState } from "@path/client-core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NodeIo } from "../src/node-io.js";
import { stubClient } from "./stub-server.js";

const ROOT = "run_root";
const RUN = "run_child";

/** One run as the live snapshot holds it — the shape the tree hands the pane. */
function runState(overrides: Partial<RunNodeState> = {}): RunNodeState {
  return {
    runId: RUN,
    rootRunId: ROOT,
    parentRunId: ROOT,
    nodeId: "draft-notes",
    nodeName: "draft-notes",
    workerName: "spawn",
    status: "succeeded",
    startedAt: "2026-07-25T10:00:00.000Z",
    finishedAt: "2026-07-25T10:00:02.000Z",
    inputRef: `runs/${ROOT}/${RUN}/input.json`,
    outputRef: `runs/${ROOT}/${RUN}/output.json`,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    reusedFromRunId: null,
    reusedFromRootRunId: null,
    workflowId: null,
    workflowName: null,
    workflowPath: null,
    ...overrides,
  };
}

describe("NodeIo", () => {
  it("renders the run's masked input and output objects", async () => {
    const client = stubClient({
      blobs: {
        [`${RUN}/input`]: { since_tag: "1.3.0", token: "[secret:github_token]" },
        [`${RUN}/output`]: { count: 2 },
      },
    });
    render(<NodeIo client={client} run={runState()} />);

    const input = await screen.findByTestId("node-io-input");
    expect(input).toHaveTextContent('"since_tag": "1.3.0"');
    // Masking happens at the persistence boundary (CONTEXT.md, Secret) — the pane renders what the
    // server sent, so the masked form must survive to the screen unaltered.
    expect(input).toHaveTextContent('"token": "[secret:github_token]"');
    expect(await screen.findByTestId("node-io-output")).toHaveTextContent('"count": 2');
  });

  it("shows each object's blob ref as its provenance", async () => {
    const client = stubClient({ blobs: { [`${RUN}/input`]: { a: 1 }, [`${RUN}/output`]: { b: 2 } } });
    render(<NodeIo client={client} run={runState()} />);

    expect(await screen.findByTestId("node-io-input")).toHaveTextContent(`runs/${ROOT}/${RUN}/input.json`);
  });

  it("reads a blob that is JSON null as a value, not as a missing object", async () => {
    const client = stubClient({ blobs: { [`${RUN}/input`]: null, [`${RUN}/output`]: null } });
    render(<NodeIo client={client} run={runState()} />);

    expect(await screen.findByTestId("node-io-output")).toHaveTextContent("null");
  });

  it("says an unwritten output is not there yet, without asking the server for it", async () => {
    // A run writes its output when it finishes, so a ref-less output is the normal mid-run state —
    // and a request for it would only earn a 404.
    const client = stubClient({ blobs: { [`${RUN}/input`]: { a: 1 } } });
    render(<NodeIo client={client} run={runState({ status: "running", outputRef: null })} />);

    const output = await screen.findByTestId("node-io-output");
    await waitFor(() => expect(output).toHaveTextContent(/No output object yet/i));
    expect(within(output).queryByRole("alert")).toBeNull();
  });

  it("reports a failure to read a referenced object as an error", async () => {
    // The record says the object is on disk; the route disagrees. That is not "not written yet".
    const client = stubClient({ blobs: { [`${RUN}/input`]: { a: 1 } } });
    render(<NodeIo client={client} run={runState()} />);

    expect(await within(await screen.findByTestId("node-io-output")).findByRole("alert")).toHaveTextContent(
      /Failed to load output/i,
    );
  });

  it("re-reads the output on its own once the finished run publishes its ref", async () => {
    const client = stubClient({
      blobs: { [`${RUN}/input`]: { a: 1 }, [`${RUN}/output`]: { done: true } },
    });
    const running = runState({ status: "running", outputRef: null });
    const view = render(<NodeIo client={client} run={running} />);

    await waitFor(() => expect(screen.getByTestId("node-io-output")).toHaveTextContent(/No output object yet/i));

    // What the live snapshot does when the run finishes: the record gains its output ref.
    view.rerender(<NodeIo client={client} run={runState()} />);

    await waitFor(() => expect(screen.getByTestId("node-io-output")).toHaveTextContent('"done": true'));
  });

  it("re-reads both objects on refresh, for a ref whose content changed underneath", async () => {
    const blobs: Record<string, unknown> = { [`${RUN}/input`]: { a: 1 }, [`${RUN}/output`]: { v: 1 } };
    const client = stubClient({ blobs });
    render(<NodeIo client={client} run={runState()} />);

    await waitFor(() => expect(screen.getByTestId("node-io-output")).toHaveTextContent('"v": 1'));

    blobs[`${RUN}/output`] = { v: 2 };
    fireEvent.click(screen.getByTestId("node-io-refresh"));

    await waitFor(() => expect(screen.getByTestId("node-io-output")).toHaveTextContent('"v": 2'));
  });

  it("re-reads when the selected run changes", async () => {
    const other = "run_other";
    const client = stubClient({
      blobs: { [`${RUN}/input`]: { which: "first" }, [`${other}/input`]: { which: "second" } },
    });
    const view = render(<NodeIo client={client} run={runState({ outputRef: null })} />);

    await waitFor(() => expect(screen.getByTestId("node-io-input")).toHaveTextContent('"first"'));

    view.rerender(
      <NodeIo
        client={client}
        run={runState({ runId: other, outputRef: null, inputRef: `runs/${ROOT}/${other}/input.json` })}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("node-io-input")).toHaveTextContent('"second"'));
  });

  it("asks for a finished run's object even when the snapshot carries no ref (#51)", async () => {
    // Refs only enter the snapshot through a tree read, and nothing re-reads the tree after the
    // last node of a tree finishes — so a terminal run with a null ref may still have written its
    // object. Trusting the ref there hides real output, and Refresh cannot rescue it.
    const client = stubClient({ blobs: { [`${RUN}/output`]: { wrote: "RELEASE_NOTES.md" } } });
    render(<NodeIo client={client} run={runState({ status: "succeeded", inputRef: null, outputRef: null })} />);

    await waitFor(() =>
      expect(screen.getByTestId("node-io-output")).toHaveTextContent('"wrote": "RELEASE_NOTES.md"'),
    );
  });

  it("reads a 404 for a finished run as an object it never recorded", async () => {
    const client = stubClient({ blobs: {} });
    render(<NodeIo client={client} run={runState({ status: "succeeded", inputRef: null, outputRef: null })} />);

    const output = await screen.findByTestId("node-io-output");
    await waitFor(() => expect(output).toHaveTextContent(/No output object recorded/i));
    expect(within(output).queryByRole("alert")).toBeNull();
  });

  it("still asks for nothing while the run is mid-flight", async () => {
    const client = stubClient({ blobs: { [`${RUN}/output`]: { premature: true } } });
    render(<NodeIo client={client} run={runState({ status: "running", outputRef: null })} />);

    const output = await screen.findByTestId("node-io-output");
    await waitFor(() => expect(output).toHaveTextContent(/No output object yet/i));
    expect(output).not.toHaveTextContent("premature");
  });

  it("names the run it is showing by node and status", async () => {
    const client = stubClient({ blobs: { [`${RUN}/input`]: { a: 1 } } });
    render(<NodeIo client={client} run={runState({ status: "failed", outputRef: null })} />);

    const head = await screen.findByTestId("node-io-head");
    expect(head).toHaveTextContent("draft-notes");
    expect(head).toHaveTextContent("failed");
  });

  it("names the reused source run+tree when the shown I/O belongs to another run (#257)", async () => {
    // A reuse row: the panel shows the source run's I/O (already resolved by the server), so it must
    // also say so and name where those bytes live — the source's root run id and run id.
    const sourceRoot = "546ca6e6-3699-4d7d-8e4e-77b133528d02";
    const sourceRun = "5d7a664d-b485-40eb-aced-265119ec5f2d";
    const client = stubClient({ blobs: { [`${RUN}/input`]: { reused: true } } });
    render(
      <NodeIo
        client={client}
        run={runState({ outputRef: null, reusedFromRunId: sourceRun, reusedFromRootRunId: sourceRoot })}
      />,
    );

    const note = await screen.findByTestId("node-io-reused");
    expect(note).toHaveTextContent(/reused from an earlier run/i);
    expect(note).toHaveTextContent(sourceRoot);
    expect(note).toHaveTextContent(sourceRun);
  });

  it("shows (deleted) for the reused source tree when it was since removed (#257)", async () => {
    const client = stubClient({ blobs: {} });
    render(
      <NodeIo
        client={client}
        run={runState({ status: "succeeded", inputRef: null, outputRef: null, reusedFromRunId: "gone", reusedFromRootRunId: null })}
      />,
    );

    const note = await screen.findByTestId("node-io-reused");
    expect(note).toHaveTextContent("(deleted)");
    expect(note).toHaveTextContent("gone");
  });

  it("shows the run's context object when the server serves one", async () => {
    const client = stubClient({
      blobs: {
        [`${RUN}/input`]: { a: 1 },
        [`${RUN}/output`]: { b: 2 },
        [`${RUN}/context`]: { since_tag: "1.3.0", token: "[secret:github_token]" },
      },
    });
    render(<NodeIo client={client} run={runState()} />);

    const context = await screen.findByTestId("node-io-context");
    expect(context).toHaveTextContent('"since_tag": "1.3.0"');
    // Context is masked at the persistence boundary too — the pane renders what it is served.
    expect(context).toHaveTextContent('"token": "[secret:github_token]"');
  });

  it("reads an absent context as no context, not an error", async () => {
    // A run with no context.json (e.g. still mid-flight) 404s on its `context` read; the 404 is
    // trusted and rendered as a plain note rather than surfaced as a failure.
    const client = stubClient({ blobs: { [`${RUN}/input`]: { a: 1 }, [`${RUN}/output`]: { b: 2 } } });
    render(<NodeIo client={client} run={runState()} />);

    const context = await screen.findByTestId("node-io-context");
    await waitFor(() => expect(context).toHaveTextContent(/No context recorded/i));
    expect(within(context).queryByRole("alert")).toBeNull();
  });

  it("re-reads the context on refresh, for a write-through that changed it underneath", async () => {
    const blobs: Record<string, unknown> = { [`${RUN}/input`]: { a: 1 }, [`${RUN}/context`]: { v: 1 } };
    const client = stubClient({ blobs });
    render(<NodeIo client={client} run={runState({ outputRef: null })} />);

    await waitFor(() => expect(screen.getByTestId("node-io-context")).toHaveTextContent('"v": 1'));

    blobs[`${RUN}/context`] = { v: 2 };
    fireEvent.click(screen.getByTestId("node-io-refresh"));

    await waitFor(() => expect(screen.getByTestId("node-io-context")).toHaveTextContent('"v": 2'));
  });

  it("shows no reuse note for an ordinary executed run", async () => {
    const client = stubClient({ blobs: { [`${RUN}/input`]: { a: 1 } } });
    render(<NodeIo client={client} run={runState({ outputRef: null })} />);

    await screen.findByTestId("node-io-input");
    expect(screen.queryByTestId("node-io-reused")).toBeNull();
  });

  it("surfaces a failed run's error message in the E block", async () => {
    const client = stubClient({ blobs: { [`${RUN}/input`]: { a: 1 } } });
    const narrative: LogEvent[] = [
      {
        type: "step-finished",
        seq: 7,
        ts: "2026-07-25T10:00:02.000Z",
        run_id: RUN,
        node_id: "draft-notes",
        node_name: "draft-notes",
        status: "failed",
        error: "worker exited with code 1: boom",
      },
    ];
    render(<NodeIo client={client} run={runState({ status: "failed" })} narrative={narrative} />);

    const error = await screen.findByTestId("node-io-error");
    expect(error).toHaveTextContent("worker exited with code 1: boom");
  });

  it("shows no E block for a run that did not fail", async () => {
    const client = stubClient({ blobs: { [`${RUN}/input`]: { a: 1 } } });
    render(<NodeIo client={client} run={runState()} />);

    await screen.findByTestId("node-io-input");
    expect(screen.queryByTestId("node-io-error")).toBeNull();
  });
});
