import { LogEventSchema } from "@path/schema";
import { describe, expect, it } from "vitest";
import type { Trace } from "../src/condition.js";
import type { RunIdentity } from "../src/run-context.js";
import { createEmitter } from "../src/run-emitter.js";
import type { RunEvent } from "../src/run-observer.js";

/**
 * The envelope logic this seam concentrates (CONTEXT, Audit — "Emitter"): the `isRoot` gating of the
 * root-only start payload, the `node`→`node_id`/`node_name` pull, the single minted step run id shared
 * across a leaf step's events, and the payload each lifecycle event carries on the side.
 */

const ROOT: RunIdentity = {
  runId: "root-run",
  rootRunId: "root-run",
  parentRunId: null,
  nodeId: null,
  nodeName: null,
};
const NESTED: RunIdentity = {
  runId: "child-run",
  rootRunId: "root-run",
  parentRunId: "root-run",
  nodeId: "wf-node-guid",
  nodeName: "child",
};

const TRACE: Trace = { type: "exists", path: "context.k", outcome: "true" } as Trace;
const TS = expect.any(String);

function sink(): { seen: RunEvent[]; emit: (e: RunEvent) => Promise<void> } {
  const seen: RunEvent[] = [];
  return { seen, emit: async (e) => void seen.push(e) };
}

describe("createEmitter — a workflow-run's start", () => {
  it("narrates the implicit root step and carries the root's trio and lineage on the side", async () => {
    const { seen, emit } = sink();
    await createEmitter(ROOT, emit).runStarted({
      input: { seed: 1 },
      resumedFromRootRunId: "prev-root",
      workflowId: "wf-guid",
      workflowName: "release",
      workflowPath: "flows/release.workflow.json",
    });

    expect(seen).toEqual([
      {
        runId: "root-run",
        rootRunId: "root-run",
        event: {
          type: "step-started",
          ts: TS,
          run_id: "root-run",
          node_id: null,
          node_name: null,
          step_type: "workflow",
          worker_name: "workflow",
        },
        payload: {
          kind: "started",
          parentRunId: null,
          input: { seed: 1 },
          resumedFromRootRunId: "prev-root",
          workflowId: "wf-guid",
          workflowName: "release",
          workflowPath: "flows/release.workflow.json",
        },
      },
    ]);
  });

  it("drops the source-workflow trio for a nested run even when supplied (root-only, ADR 0006)", async () => {
    const { seen, emit } = sink();
    await createEmitter(NESTED, emit).runStarted({
      input: {},
      workflowId: "wf-guid",
      workflowName: "release",
      workflowPath: "flows/release.workflow.json",
    });

    const [e] = seen;
    expect(e).toMatchObject({
      runId: "child-run",
      event: { run_id: "child-run", node_id: "wf-node-guid", node_name: "child" },
      payload: { kind: "started", parentRunId: "root-run" },
    });
    expect(e!.payload).not.toHaveProperty("workflowId");
    expect(e!.payload).not.toHaveProperty("workflowName");
    expect(e!.payload).not.toHaveProperty("workflowPath");
  });

  it("omits every optional key when none is supplied", async () => {
    const { seen, emit } = sink();
    await createEmitter(ROOT, emit).runStarted({ input: {} });

    const payload = seen[0]!.payload;
    expect(payload).not.toHaveProperty("resumedFromRootRunId");
    expect(payload).not.toHaveProperty("workflowId");
    expect(payload).not.toHaveProperty("workflowPath");
  });
});

describe("createEmitter — run terminal + context", () => {
  it("narrates each run outcome as a step-finished, the output on the side", async () => {
    const { seen, emit } = sink();
    const e = createEmitter(ROOT, emit);
    await e.runFinished({ status: "succeeded", output: { ok: true } });
    await e.runFinished({ status: "failed", error: "boom" });
    await e.runFinished({ status: "cancelled" });

    const env = { ts: TS, run_id: "root-run", node_id: null, node_name: null };
    expect(seen).toEqual([
      {
        runId: "root-run",
        rootRunId: "root-run",
        event: { type: "step-finished", ...env, status: "succeeded" },
        payload: { kind: "output", output: { ok: true } },
      },
      {
        runId: "root-run",
        rootRunId: "root-run",
        event: { type: "step-finished", ...env, status: "failed", error: "boom" },
      },
      {
        runId: "root-run",
        rootRunId: "root-run",
        event: { type: "step-finished", ...env, status: "cancelled" },
      },
    ]);
  });

  it("records a context change with no log event", async () => {
    const { seen, emit } = sink();
    await createEmitter(ROOT, emit).record({ kind: "context", context: { a: 1 } });
    expect(seen).toEqual([
      {
        runId: "root-run",
        rootRunId: "root-run",
        event: null,
        payload: { kind: "context", context: { a: 1 } },
      },
    ]);
  });
});

describe("createEmitter — control-node events", () => {
  const node = { id: "node-guid", name: "gate" };

  it("stamps the enclosing run's id and the given node onto the body", async () => {
    const { seen, emit } = sink();
    await createEmitter(NESTED, emit).emit(node, {
      type: "branch-taken",
      arm: "else",
      trace: null,
    });

    expect(seen).toEqual([
      {
        runId: "child-run",
        rootRunId: "root-run",
        event: {
          type: "branch-taken",
          ts: TS,
          run_id: "child-run",
          node_id: "node-guid",
          node_name: "gate",
          arm: "else",
          trace: null,
        },
      },
    ]);
  });

  it("names no node when given null (goto pass 1)", async () => {
    const { seen, emit } = sink();
    await createEmitter(NESTED, emit).emit(null, { type: "pass-started", pass: 1 });
    expect(seen[0]!.event).toMatchObject({ run_id: "child-run", node_id: null, node_name: null });
  });
});

describe("createEmitter — step sub-emitter", () => {
  const node = { id: "step-guid", name: "compile" };

  it("shares one minted run id across the step's events, parented to the run", async () => {
    const { seen, emit } = sink();
    const step = createEmitter(NESTED, emit).step(node);

    await step.started({ stepType: "binary", workerName: "spawn", input: { x: 1 } });
    await step.record({ kind: "usage", usage: { tokens: 10 }, estimatedCostUsd: 0.02 });
    await step.record({ kind: "stderr", stderr: "warn: slow" });
    await step.finished({ status: "succeeded", output: "done" });

    // Every event of the step shares the minted id, distinct from the enclosing run's id...
    expect(new Set(seen.map((e) => e.runId))).toEqual(new Set([step.runId]));
    expect(step.runId).not.toBe(NESTED.runId);
    // ...and its start names the enclosing workflow-run as its parent.
    expect(seen[0]).toMatchObject({
      event: {
        type: "step-started",
        run_id: step.runId,
        node_id: "step-guid",
        node_name: "compile",
        step_type: "binary",
        worker_name: "spawn",
      },
      payload: { kind: "started", parentRunId: "child-run", input: { x: 1 } },
    });
    expect(seen.map((e) => e.event?.type ?? e.payload?.kind)).toEqual([
      "step-started",
      "usage",
      "stderr",
      "step-finished",
    ]);
  });

  it("cancelled narrates run-cancelled then a cancelled step-finished, in that order", async () => {
    const { seen, emit } = sink();
    const step = createEmitter(NESTED, emit).step(node);

    await step.cancelled({ cause: "sibling-failed", causeRunId: "villain-run" });

    const env = { ts: TS, run_id: step.runId, node_id: "step-guid", node_name: "compile" };
    expect(seen.map((e) => e.event)).toEqual([
      { type: "run-cancelled", ...env, cause: "sibling-failed", cause_run_id: "villain-run" },
      { type: "step-finished", ...env, status: "cancelled" },
    ]);
  });

  it("mints a fresh id per step()", async () => {
    const { emit } = sink();
    const e = createEmitter(NESTED, emit);
    expect(e.step(node).runId).not.toBe(e.step(node).runId);
  });
});

describe("createEmitter — every narrated event is a log event", () => {
  it("validates against the log-event schema once sequenced", async () => {
    const { seen, emit } = sink();
    const e = createEmitter(NESTED, emit);
    const node = { id: "n1", name: "gate" };
    const target = { target_node_id: "n2", target_node_name: "b" };
    await e.runStarted({ input: {} });
    await e.emit(node, { type: "checkpoint-passed", trace: TRACE });
    await e.emit(node, { type: "checkpoint-failed", trace: TRACE });
    await e.emit(node, { type: "branch-taken", arm: 0, trace: TRACE });
    await e.emit(node, { type: "branch-no-match", traces: [TRACE] });
    await e.emit(node, { type: "iteration-started", iteration: 1, trace: TRACE });
    await e.emit(node, {
      type: "loop-exited",
      reason: "condition-false",
      iterations: 2,
      trace: TRACE,
    });
    await e.emit(node, { type: "join-applied", branches: ["a"], published_keys: ["k"] });
    await e.emit(node, { type: "reuse-marker", original_run_id: "orig" });
    await e.emit(null, { type: "pass-started", pass: 1 });
    await e.emit(node, { type: "goto-taken", ...target, jump: 1, max_jumps: 3, pass: 2 });
    await e.emit(node, { type: "goto-exhausted", ...target, max_jumps: 3, pass: 4 });
    const step = e.step(node);
    await step.started({ stepType: "binary", workerName: "spawn", input: {} });
    await step.emit({ type: "step-awaiting", assignee: null });
    await step.cancelled({ cause: "operator", causeRunId: null });
    await e.runFinished({ status: "succeeded", output: {} });

    for (const [i, { event }] of seen.entries())
      expect(() => LogEventSchema.parse({ ...event, seq: i + 1 })).not.toThrow();
  });
});
