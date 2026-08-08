import { describe, expect, it } from "vitest";
import { LogEventSchema } from "@path/schema";
import { toLogEvent } from "../../src/logging/logging-observer.js";
import type { Observation } from "../../src/run-observer.js";

const ids = { runId: "r1", rootRunId: "r0" };
const worker = { type: "engine" } as const;
const trace = { type: "exists", path: "context.k", outcome: "true" } as const;

/** Records which nodeId the projection asked for — part of what the projection decides. */
function recordingEnvelope(): {
  envelope: (runId: string, nodeId?: string) => { seq: number; ts: string; run_id: string; node_id: string | null };
  asked: (string | undefined)[];
} {
  const asked: (string | undefined)[] = [];
  let seq = 0;
  return {
    asked,
    envelope: (runId, nodeId) => {
      asked.push(nodeId);
      return { seq: (seq += 1), ts: "2026-01-01T00:00:00.000Z", run_id: runId, node_id: nodeId ?? null };
    },
  };
}

function project(o: Observation) {
  const { envelope, asked } = recordingEnvelope();
  return { event: toLogEvent(o, envelope), asked };
}

describe("toLogEvent", () => {
  it("does not narrate the three persistence-only observations", () => {
    const persistenceOnly: Observation[] = [
      { type: "step-stderr", ...ids, stderr: "boom" },
      { type: "step-usage", ...ids, usage: { in: 1 }, estimatedCostUsd: 0.01 },
      { type: "context-changed", ...ids, context: { k: 1 } },
    ];
    for (const o of persistenceOnly) expect(project(o).event).toBeNull();
  });

  it("narrates a workflow-run's start as the implicit root step (invariant 2)", () => {
    const { event } = project({
      type: "run-started",
      ...ids,
      parentRunId: null,
      nodeId: null,
      input: { secret: "payload" },
      worker,
    });
    expect(event).toMatchObject({ type: "step-started", step_type: "workflow", worker });
    expect(event).not.toHaveProperty("input");
  });

  it("drops payloads — they reach the log only as blob refs on the run row", () => {
    const started = project({
      type: "step-started",
      ...ids,
      parentRunId: "r0",
      nodeId: "n1",
      stepType: "binary",
      worker,
      input: { big: "payload" },
    }).event;
    expect(started).not.toHaveProperty("input");
    expect(started).toMatchObject({ type: "step-started", step_type: "binary" });

    const finished = project({ type: "step-finished", ...ids, status: "succeeded", output: { big: "payload" } }).event;
    expect(finished).not.toHaveProperty("output");
    expect(finished).toMatchObject({ type: "step-finished", status: "succeeded" });
  });

  it("collapses run-finished and step-finished onto one event", () => {
    const outcome = { status: "failed", error: "boom" } as const;
    expect(project({ type: "step-finished", ...ids, ...outcome }).event).toMatchObject({
      type: "step-finished",
      status: "failed",
      error: "boom",
    });
    expect(project({ type: "run-finished", ...ids, ...outcome }).event).toMatchObject({
      type: "step-finished",
      status: "failed",
      error: "boom",
    });
  });

  it("carries no error on a cancelled finish — run-cancelled narrates the cause", () => {
    const event = project({ type: "run-finished", ...ids, status: "cancelled" }).event;
    expect(event).toMatchObject({ type: "step-finished", status: "cancelled" });
    expect(event).not.toHaveProperty("error");
  });

  it("splits checkpoint-evaluated on its outcome", () => {
    const base = { type: "checkpoint-evaluated", ...ids, nodeId: "n1", trace } as const;
    expect(project({ ...base, passed: true }).event).toMatchObject({ type: "checkpoint-passed", trace });
    expect(project({ ...base, passed: false }).event).toMatchObject({ type: "checkpoint-failed", trace });
  });

  it("attributes control-node events to the control node, lifecycle events to the run", () => {
    expect(project({ type: "join-applied", ...ids, nodeId: "n7", branches: ["a"], publishedKeys: ["k"] }).asked).toEqual([
      "n7",
    ]);
    expect(project({ type: "step-finished", ...ids, status: "cancelled" }).asked).toEqual([undefined]);
  });

  it("renames the fields the wire format spells differently", () => {
    expect(project({ type: "join-applied", ...ids, nodeId: "n1", branches: ["a"], publishedKeys: ["k"] }).event).toMatchObject(
      { published_keys: ["k"] },
    );
    expect(
      project({ type: "run-cancelled", ...ids, nodeId: "n1", cause: "operator", causeRunId: null }).event,
    ).toMatchObject({ cause: "operator", cause_run_id: null });
  });

  it("narrates a reuse-marker with the reused node's id and the original run back-reference (#172)", () => {
    const { event, asked } = project({ type: "reuse-marker", ...ids, nodeId: "n9", originalRunId: "orig-run" });
    expect(event).toMatchObject({ type: "reuse-marker", node_id: "n9", original_run_id: "orig-run", run_id: "r1" });
    expect(asked).toEqual(["n9"]); // attributed to the reused node's own id
  });

  it("emits only events that validate against the log-event schema", () => {
    const every: Observation[] = [
      { type: "reuse-marker", ...ids, nodeId: "n1", originalRunId: "orig-run" },
      { type: "run-started", ...ids, parentRunId: null, nodeId: null, input: {}, worker },
      { type: "step-started", ...ids, parentRunId: "r0", nodeId: "n1", stepType: "binary", worker, input: {} },
      { type: "step-finished", ...ids, status: "succeeded", output: {} },
      { type: "run-finished", ...ids, status: "cancelled" },
      { type: "checkpoint-evaluated", ...ids, nodeId: "n1", passed: true, trace },
      { type: "branch-taken", ...ids, nodeId: "n1", arm: "else", trace: null },
      { type: "branch-no-match", ...ids, nodeId: "n1", traces: [trace] },
      { type: "iteration-started", ...ids, nodeId: "n1", iteration: 1, trace },
      { type: "loop-exited", ...ids, nodeId: "n1", reason: "condition-false", iterations: 2, trace },
      { type: "join-applied", ...ids, nodeId: "n1", branches: ["a"], publishedKeys: ["k"] },
      { type: "run-cancelled", ...ids, nodeId: "n1", cause: "sibling-failed", causeRunId: "r2" },
    ];
    for (const o of every) {
      const event = toLogEvent(o, (runId, nodeId) => ({
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        run_id: runId,
        node_id: nodeId ?? null,
      }));
      expect(event, `${o.type} should be narrated`).not.toBeNull();
      expect(() => LogEventSchema.parse(event)).not.toThrow();
    }
  });
});
