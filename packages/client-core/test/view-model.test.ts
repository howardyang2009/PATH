import { describe, expect, it, vi } from "vitest";
import { RunViewModel, type RunViewState } from "../src/view-model.js";
import type { LogEvent, RunTreeResponse } from "@path/schema";

const ROOT = "root-1";
const CHILD = "child-1";

function stepStarted(seq: number, runId: string, nodeId: string | null): LogEvent {
  return { type: "step-started", seq, ts: `t${seq}`, run_id: runId, node_id: nodeId, node_name: nodeId, step_type: "workflow", worker_name: "spawn" };
}

function stepFinished(seq: number, runId: string, nodeId: string | null, status: "succeeded" | "failed" | "cancelled" = "succeeded"): LogEvent {
  return { type: "step-finished", seq, ts: `t${seq}`, run_id: runId, node_id: nodeId, node_name: nodeId, status };
}

function tree(status: RunViewState["status"], output: RunTreeResponse["output"] = null): RunTreeResponse {
  return {
    root_run_id: ROOT,
    status,
    output,
    runs: [
      {
        run_id: ROOT,
        root_run_id: ROOT,
        parent_run_id: null,
        node_id: null,
        node_name: null,
        worker_name: "spawn",
        status,
        started_at: "t0",
        finished_at: null,
        input_ref: "runs/root-1/root-1/input.json",
        output_ref: null,
        usage: null,
        estimated_cost_usd: null,
        resumed_from_root_run_id: null,
        reused_from_run_id: null,
        reused_from_root_run_id: null,
        workflow_id: null,
        workflow_name: null,
        workflow_path: null,
      },
    ],
  };
}

describe("RunViewModel", () => {
  it("hydrates the tree from GET /v0/runs/:id", () => {
    const model = new RunViewModel(ROOT);
    model.hydrate(tree("running"));
    const state = model.getState();
    expect(state.status).toBe("running");
    expect(state.runs.get(ROOT)?.inputRef).toBe("runs/root-1/root-1/input.json");
    expect(state.narrative).toHaveLength(0);
  });

  it("carries the root run's workflow identity through hydrate", () => {
    const model = new RunViewModel(ROOT);
    const t = tree("running");
    t.runs[0]!.workflow_id = "018f3a2b-0000-7000-8000-000000000001";
    t.runs[0]!.workflow_name = "release-notes";
    t.runs[0]!.workflow_path = "release-notes.workflow.json";
    model.hydrate(t);
    const root = model.getState().runs.get(ROOT);
    expect(root?.workflowId).toBe("018f3a2b-0000-7000-8000-000000000001");
    expect(root?.workflowName).toBe("release-notes");
    expect(root?.workflowPath).toBe("release-notes.workflow.json");
  });

  it("folds step lifecycle events into per-run status and the root status", () => {
    const model = new RunViewModel(ROOT);
    model.applyEvent(stepStarted(1, ROOT, null));
    expect(model.getState().status).toBe("running");
    expect(model.getState().runs.get(ROOT)?.workerName).toBe("spawn");

    model.applyEvent(stepStarted(2, CHILD, "draft"));
    expect(model.getState().runs.get(CHILD)?.status).toBe("running");

    model.applyEvent(stepFinished(3, CHILD, "draft"));
    expect(model.getState().runs.get(CHILD)?.status).toBe("succeeded");
    expect(model.getState().runs.get(CHILD)?.finishedAt).toBe("t3");
    // Root not finished yet.
    expect(model.getState().status).toBe("running");

    model.applyEvent(stepFinished(4, ROOT, null));
    expect(model.getState().status).toBe("succeeded");
    expect(model.getState().narrative.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("ignores duplicate seqs (replay/live overlap) and keeps the narrative seq-ordered", () => {
    const model = new RunViewModel(ROOT);
    model.applyEvent(stepStarted(1, ROOT, null));
    model.applyEvent(stepFinished(3, ROOT, null));
    // A late/out-of-order replay of seq 2 slots between 1 and 3.
    model.applyEvent(stepStarted(2, CHILD, "draft"));
    // A duplicate of an already-seen seq is dropped.
    model.applyEvent(stepStarted(2, CHILD, "draft"));
    expect(model.getState().narrative.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("never walks a finished run back to running on a full replay", () => {
    const model = new RunViewModel(ROOT);
    model.hydrate(tree("succeeded"));

    // No `Last-Event-ID` to resume from means the server replays from seq 1, so the root's own
    // `step-started` arrives against an already-succeeded run.
    model.applyEvent(stepStarted(1, ROOT, null));

    expect(model.getState().status).toBe("succeeded");
    expect(model.getState().runs.get(ROOT)?.workerName).toBe("spawn");
  });

  it("takes structure from a re-read tree without regressing a run the events already finished", () => {
    const model = new RunViewModel(ROOT);
    model.applyEvent(stepStarted(1, CHILD, "draft"));
    model.applyEvent(stepFinished(2, CHILD, "draft"));

    const reread = tree("running");
    reread.runs.push({
      run_id: CHILD,
      root_run_id: ROOT,
      parent_run_id: ROOT,
      node_id: "draft",
      node_name: "draft",
      worker_name: "spawn",
      // The row was read before the engine persisted the finish.
      status: "running",
      started_at: "t1",
      finished_at: null,
      input_ref: null,
      output_ref: null,
      usage: null,
      estimated_cost_usd: null,
      resumed_from_root_run_id: null,
      reused_from_run_id: null,
      reused_from_root_run_id: null,
      workflow_id: null,
      workflow_name: null,
      workflow_path: null,
    });
    model.hydrate(reread);

    const child = model.getState().runs.get(CHILD);
    expect(child?.parentRunId).toBe(ROOT);
    expect(child?.status).toBe("succeeded");
    expect(child?.finishedAt).toBe("t2");
  });

  it("notifies subscribers on each change and stops after unsubscribe", () => {
    const model = new RunViewModel(ROOT);
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    model.applyEvent(stepStarted(1, ROOT, null));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.lastCall?.[0].status).toBe("running");
    unsubscribe();
    model.applyEvent(stepFinished(2, ROOT, null));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("carries the event-stream phase, starting at connecting", () => {
    const model = new RunViewModel(ROOT);
    expect(model.getState().stream).toBe("connecting");

    const listener = vi.fn();
    model.subscribe(listener);
    model.setStreamPhase("live");

    expect(model.getState().stream).toBe("live");
    expect(listener.mock.lastCall?.[0].stream).toBe("live");
  });

  it("does not notify when the stream phase is set to the phase it is already in", () => {
    const model = new RunViewModel(ROOT);
    model.setStreamPhase("live");
    const listener = vi.fn();
    model.subscribe(listener);

    model.setStreamPhase("live");

    expect(listener).not.toHaveBeenCalled();
  });
});
