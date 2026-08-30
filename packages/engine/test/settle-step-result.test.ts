import { describe, expect, it } from "vitest";
import type { JsonValue } from "@path/schema";
import { createEmitter, type StepEmitter } from "../src/run-emitter.js";
import type { Cancellation, RunIdentity } from "../src/run-context.js";
import type { Observation } from "../src/run-observer.js";
import type { StepResult } from "../src/plugin/seam.js";
import { settleStepResult, type SettleStepResult } from "../src/run-workflow.js";

/**
 * The engine-owned mapping from a worker's `StepResult` to a leaf step's terminal outcome, tested on
 * its own seam (#349's class) — no worker, no semaphore, no registry, no pipeline. A real `StepEmitter`
 * over a recording sink is what proves the *observations* the mapping emits, in order, are the wire
 * shapes persistence and logging read. What a worker self-reports is its business (an SDK "success"
 * frame it judges an error is failed at the worker); what the engine does with whatever came back is
 * this, and it is one place.
 */

const IDENTITY: RunIdentity = { runId: "wf-run", rootRunId: "root-run", parentRunId: null, nodeId: null, nodeName: null };
const NODE = { id: "step-node-guid", name: "do-thing" };

// A real step emitter over a recording sink: `seen` is every wire `Observation` the mapping produced,
// and `step.runId` is the minted id a failure names itself by (a cancelling sibling's `causeRunId`).
function harness(): { step: StepEmitter; seen: Observation[] } {
  const seen: Observation[] = [];
  const emit = async (o: Observation): Promise<void> => void seen.push(o);
  const step = createEmitter(IDENTITY, emit).step(NODE);
  return { step, seen };
}

function settle(over: Partial<SettleStepResult> & { result: StepResult; step: StepEmitter }): ReturnType<typeof settleStepResult> {
  return settleStepResult({ node: NODE, meters: false, signal: undefined, cancellation: undefined, ...over });
}

describe("settleStepResult — success", () => {
  it("passes a worker's output straight through and finishes succeeded", async () => {
    const { step, seen } = harness();
    const outcome = await settle({ step, result: { status: "succeeded", output: { answer: 42 } } });

    expect(outcome).toEqual({ status: "succeeded", output: { answer: 42 } });
    expect(seen).toEqual([
      { type: "step-finished", runId: step.runId, rootRunId: "root-run", status: "succeeded", output: { answer: 42 } },
    ]);
  });

  it('applies parse: "json" to a string result', async () => {
    const { step, seen } = harness();
    const outcome = await settle({ step, node: { ...NODE, parse: "json" }, result: { status: "succeeded", output: '{"n":1}' } });

    expect(outcome).toEqual({ status: "succeeded", output: { n: 1 } });
    expect(seen.at(-1)).toMatchObject({ type: "step-finished", status: "succeeded", output: { n: 1 } });
  });

  it('leaves a non-string output un-parsed even under parse: "json"', async () => {
    const { step } = harness();
    const already: JsonValue = { n: 1 };
    const outcome = await settle({ step, node: { ...NODE, parse: "json" }, result: { status: "succeeded", output: already } });

    expect(outcome).toEqual({ status: "succeeded", output: already });
  });

  it('fails the step, with its own run as the cause, when parse: "json" cannot parse the string', async () => {
    const { step, seen } = harness();
    const outcome = await settle({ step, node: { ...NODE, parse: "json" }, result: { status: "succeeded", output: "not json" } });

    expect(outcome.status).toBe("failed");
    expect(outcome).toMatchObject({ status: "failed", causeRunId: step.runId });
    expect((outcome as { error: string }).error).toContain('step "do-thing"');
    expect(seen.at(-1)).toMatchObject({ type: "step-finished", status: "failed" });
  });
});

describe("settleStepResult — failure", () => {
  it("prefixes the node name onto the worker error and names its own run the cause", async () => {
    const { step, seen } = harness();
    const outcome = await settle({ step, result: { status: "failed", error: "exited with code 2" } });

    expect(outcome).toEqual({ status: "failed", error: 'step "do-thing": exited with code 2', causeRunId: step.runId });
    expect(seen).toEqual([
      { type: "step-finished", runId: step.runId, rootRunId: "root-run", status: "failed", error: 'step "do-thing": exited with code 2' },
    ]);
  });
});

describe("settleStepResult — cancelled outranks the worker's verdict", () => {
  it("relabels an aborted step cancelled even when the worker returned succeeded, landing no output", async () => {
    const { step, seen } = harness();
    const controller = new AbortController();
    controller.abort();
    const outcome = await settle({ step, signal: controller.signal, result: { status: "succeeded", output: "would-have-published" } });

    expect(outcome).toEqual({ status: "cancelled" });
    // The kill pair, in order: run-cancelled (with the cause) then the cancelled step-finished.
    expect(seen.map((o) => o.type)).toEqual(["run-cancelled", "step-finished"]);
    expect(seen[1]).toMatchObject({ type: "step-finished", status: "cancelled" });
  });

  it("carries a sibling-failed cause and its causing run onto run-cancelled", async () => {
    const { step, seen } = harness();
    const controller = new AbortController();
    controller.abort();
    const cancellation = { cause: "sibling-failed", causeRunId: "the-failing-sibling" } as unknown as Cancellation;
    await settle({ step, signal: controller.signal, cancellation, result: { status: "failed", error: "killed mid-flight" } });

    expect(seen[0]).toMatchObject({ type: "run-cancelled", cause: "sibling-failed", causeRunId: "the-failing-sibling" });
  });

  it("reads operator / null cause when there is no enclosing cancellation", async () => {
    const { step, seen } = harness();
    const controller = new AbortController();
    controller.abort();
    await settle({ step, signal: controller.signal, result: { status: "succeeded", output: "x" } });

    expect(seen[0]).toMatchObject({ type: "run-cancelled", cause: "operator", causeRunId: null });
  });
});

describe("settleStepResult — stderr rides every outcome", () => {
  it("captures stderr first, before any terminal event, on a success", async () => {
    const { step, seen } = harness();
    await settle({ step, result: { status: "succeeded", output: "ok", stderr: "a warning" } });

    expect(seen[0]).toEqual({ type: "step-stderr", runId: step.runId, rootRunId: "root-run", stderr: "a warning" });
    expect(seen.at(-1)).toMatchObject({ type: "step-finished", status: "succeeded" });
  });

  it("captures stderr even on a cancelled step", async () => {
    const { step, seen } = harness();
    const controller = new AbortController();
    controller.abort();
    await settle({ step, signal: controller.signal, result: { status: "failed", error: "boom", stderr: "the tail" } });

    expect(seen.map((o) => o.type)).toEqual(["step-stderr", "run-cancelled", "step-finished"]);
  });
});

describe("settleStepResult — usage is leaf-only and metering-gated", () => {
  it("emits step-usage before the finish for a metering worker, on success", async () => {
    const { step, seen } = harness();
    await settle({ step, meters: true, result: { status: "succeeded", output: "ok", usage: { in: 10 }, estimatedCostUsd: 0.01 } });

    expect(seen.map((o) => o.type)).toEqual(["step-usage", "step-finished"]);
    expect(seen[0]).toMatchObject({ type: "step-usage", usage: { in: 10 }, estimatedCostUsd: 0.01 });
  });

  it("emits usage for a failed metering step too — a step that died mid-conversation still spent tokens", async () => {
    const { step, seen } = harness();
    await settle({ step, meters: true, result: { status: "failed", error: "mid-flight", usage: { in: 5 } } });

    expect(seen.map((o) => o.type)).toEqual(["step-usage", "step-finished"]);
    expect(seen[0]).toMatchObject({ type: "step-usage", usage: { in: 5 }, estimatedCostUsd: null });
  });

  it("never emits usage for a non-metering worker, even when the result carries figures", async () => {
    const { step, seen } = harness();
    await settle({ step, meters: false, result: { status: "succeeded", output: "ok", usage: { in: 9 }, estimatedCostUsd: 0.5 } });

    expect(seen.map((o) => o.type)).toEqual(["step-finished"]);
  });
});
