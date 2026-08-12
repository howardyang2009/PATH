import type { JsonValue, Worker } from "@path/schema";
import { describe, expect, it } from "vitest";
import type { Trace } from "../src/condition.js";
import { createEmitter } from "../src/run-emitter.js";
import type { RunIdentity } from "../src/run-context.js";
import type { Observation } from "../src/run-observer.js";

/**
 * The envelope logic this seam concentrates (CONTEXT, Audit — "Emitter"): the `isRoot` gating of the
 * root-only `run-started` extras, the `node`→`nodeId`/`nodeName` pull, and the single minted step run
 * id shared across a leaf step's observations. This is the behaviour that used to be respelled at ~28
 * call sites and rippled on every identity-shape change (ADR 0006/0007) — so it earns its own test,
 * distinct from the walker tests that assert the same wire `Observation`s through a real emitter.
 */

const ROOT: RunIdentity = { runId: "root-run", rootRunId: "root-run", parentRunId: null, nodeId: null, nodeName: null };
const NESTED: RunIdentity = {
  runId: "child-run",
  rootRunId: "root-run",
  parentRunId: "root-run",
  nodeId: "wf-node-guid",
  nodeName: "child",
};

const WORKER = { type: "llm", model: "test-model" } as unknown as Worker;
const TRACE = { fake: "trace" } as unknown as Trace;

function sink(): { seen: Observation[]; emit: (o: Observation) => Promise<void> } {
  const seen: Observation[] = [];
  return { seen, emit: async (o) => void seen.push(o) };
}

describe("createEmitter — run-started envelope", () => {
  it("stamps the root's source-workflow trio and lineage, all under one envelope", async () => {
    const { seen, emit } = sink();
    await createEmitter(ROOT, emit).runStarted({
      input: { seed: 1 },
      worker: WORKER,
      resumedFromRootRunId: "prev-root",
      workflowId: "wf-guid",
      workflowName: "release",
      workflowPath: "flows/release.workflow.json",
    });

    expect(seen).toEqual([
      {
        type: "run-started",
        runId: "root-run",
        rootRunId: "root-run",
        parentRunId: null,
        nodeId: null,
        nodeName: null,
        input: { seed: 1 },
        worker: WORKER,
        resumedFromRootRunId: "prev-root",
        workflowId: "wf-guid",
        workflowName: "release",
        workflowPath: "flows/release.workflow.json",
      },
    ]);
  });

  it("drops the source-workflow trio for a nested run even when supplied (root-only, ADR 0006)", async () => {
    const { seen, emit } = sink();
    await createEmitter(NESTED, emit).runStarted({
      input: {},
      worker: WORKER,
      workflowId: "wf-guid",
      workflowName: "release",
      workflowPath: "flows/release.workflow.json",
    });

    const [obs] = seen;
    expect(obs).toMatchObject({
      type: "run-started",
      runId: "child-run",
      parentRunId: "root-run",
      nodeId: "wf-node-guid",
      nodeName: "child",
    });
    expect(obs).not.toHaveProperty("workflowId");
    expect(obs).not.toHaveProperty("workflowName");
    expect(obs).not.toHaveProperty("workflowPath");
  });

  it("omits every optional key when none is supplied", async () => {
    const { seen, emit } = sink();
    await createEmitter(ROOT, emit).runStarted({ input: {}, worker: WORKER });

    const [obs] = seen;
    expect(obs).not.toHaveProperty("resumedFromRootRunId");
    expect(obs).not.toHaveProperty("workflowId");
    expect(obs).not.toHaveProperty("workflowPath");
  });
});

describe("createEmitter — run terminal + context", () => {
  it("spreads each run-finished outcome verbatim", async () => {
    const { seen, emit } = sink();
    const e = createEmitter(ROOT, emit);
    await e.runFinished({ status: "succeeded", output: { ok: true } });
    await e.runFinished({ status: "failed", error: "boom" });
    await e.runFinished({ status: "cancelled" });

    expect(seen).toEqual([
      { type: "run-finished", runId: "root-run", rootRunId: "root-run", status: "succeeded", output: { ok: true } },
      { type: "run-finished", runId: "root-run", rootRunId: "root-run", status: "failed", error: "boom" },
      { type: "run-finished", runId: "root-run", rootRunId: "root-run", status: "cancelled" },
    ]);
  });

  it("carries context on context-changed", async () => {
    const { seen, emit } = sink();
    const ctx: JsonValue = { a: 1 };
    await createEmitter(ROOT, emit).contextChanged(ctx);
    expect(seen).toEqual([{ type: "context-changed", runId: "root-run", rootRunId: "root-run", context: ctx }]);
  });
});

describe("createEmitter — control nodes pull node id/name off the node", () => {
  const node = { id: "node-guid", name: "gate" };

  it("checkpointEvaluated / branchTaken / branchNoMatch", async () => {
    const { seen, emit } = sink();
    const e = createEmitter(NESTED, emit);
    await e.checkpointEvaluated(node, { passed: false, trace: TRACE });
    await e.branchTaken(node, { arm: "else", trace: null });
    await e.branchNoMatch(node, { traces: [TRACE] });

    expect(seen).toEqual([
      { type: "checkpoint-evaluated", runId: "child-run", rootRunId: "root-run", nodeId: "node-guid", nodeName: "gate", passed: false, trace: TRACE },
      { type: "branch-taken", runId: "child-run", rootRunId: "root-run", nodeId: "node-guid", nodeName: "gate", arm: "else", trace: null },
      { type: "branch-no-match", runId: "child-run", rootRunId: "root-run", nodeId: "node-guid", nodeName: "gate", traces: [TRACE] },
    ]);
  });

  it("iterationStarted / loopExited / reuseMarker", async () => {
    const { seen, emit } = sink();
    const e = createEmitter(NESTED, emit);
    await e.iterationStarted(node, { iteration: 2, trace: TRACE });
    await e.loopExited(node, { reason: "max-iterations-exceeded", iterations: 3, trace: TRACE });
    await e.reuseMarker(node, { originalRunId: "orig-run" });

    expect(seen).toEqual([
      { type: "iteration-started", runId: "child-run", rootRunId: "root-run", nodeId: "node-guid", nodeName: "gate", iteration: 2, trace: TRACE },
      { type: "loop-exited", runId: "child-run", rootRunId: "root-run", nodeId: "node-guid", nodeName: "gate", reason: "max-iterations-exceeded", iterations: 3, trace: TRACE },
      { type: "reuse-marker", runId: "child-run", rootRunId: "root-run", nodeId: "node-guid", nodeName: "gate", originalRunId: "orig-run" },
    ]);
  });

  it("joinApplied includes winner only when given", async () => {
    const { seen, emit } = sink();
    const e = createEmitter(NESTED, emit);
    await e.joinApplied(node, { branches: ["a", "b"], publishedKeys: ["k"] });
    await e.joinApplied(node, { branches: ["a"], publishedKeys: [], winner: "a" });

    expect(seen[0]).not.toHaveProperty("winner");
    expect(seen[1]).toMatchObject({ winner: "a" });
  });
});

describe("createEmitter — step sub-emitter", () => {
  const node = { id: "step-guid", name: "compile" };

  it("shares one minted run id across the step's observations, parented to the run", async () => {
    const { seen, emit } = sink();
    const step = createEmitter(NESTED, emit).step(node);

    await step.started({ stepType: "binary", worker: WORKER, input: { x: 1 } });
    await step.usage({ usage: { tokens: 10 }, estimatedCostUsd: 0.02 });
    await step.stderr("warn: slow");
    await step.finished({ status: "succeeded", output: "done" });

    // Every observation of the step shares the minted id, distinct from the enclosing run's id...
    const ids = new Set(seen.map((o) => (o as { runId: string }).runId));
    expect(ids).toEqual(new Set([step.runId]));
    expect(step.runId).not.toBe(NESTED.runId);
    // ...and step-started names the enclosing workflow-run as its parent.
    expect(seen[0]).toMatchObject({ type: "step-started", parentRunId: "child-run", nodeId: "step-guid", nodeName: "compile", stepType: "binary" });
    expect(seen.map((o) => o.type)).toEqual(["step-started", "step-usage", "step-stderr", "step-finished"]);
  });

  it("cancelled narrates run-cancelled then a cancelled step-finished, in that order", async () => {
    const { seen, emit } = sink();
    const step = createEmitter(NESTED, emit).step(node);

    await step.cancelled({ cause: "sibling-failed", causeRunId: "villain-run" });

    expect(seen).toEqual([
      { type: "run-cancelled", runId: step.runId, rootRunId: "root-run", nodeId: "step-guid", nodeName: "compile", cause: "sibling-failed", causeRunId: "villain-run" },
      { type: "step-finished", runId: step.runId, rootRunId: "root-run", status: "cancelled" },
    ]);
  });

  it("mints a fresh id per step()", async () => {
    const { emit } = sink();
    const e = createEmitter(NESTED, emit);
    expect(e.step(node).runId).not.toBe(e.step(node).runId);
  });
});
