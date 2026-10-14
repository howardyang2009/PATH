import type { LogEvent } from "@path/schema";
import { describe, expect, it } from "vitest";
import { narrativeRows } from "../src/narrative-rows.js";
import { RunViewModel } from "../src/view-model.js";

const ROOT = "root-1";

function step(
  type: "step-started" | "step-finished",
  seq: number,
  runId: string,
  nodeId: string | null,
): LogEvent {
  const base = { seq, ts: `t${seq}`, run_id: runId, node_id: nodeId, node_name: nodeId };
  return type === "step-started"
    ? { ...base, type, step_type: "workflow", worker_name: "workflow" }
    : { ...base, type, status: "succeeded" };
}

function passStarted(seq: number, nodeId: string | null, pass: number): LogEvent {
  return {
    type: "pass-started",
    seq,
    ts: `t${seq}`,
    run_id: ROOT,
    node_id: nodeId,
    node_name: nodeId,
    pass,
  };
}

describe("narrativeRows", () => {
  it("drops a goto pass container's own step rows and keeps the root's", () => {
    const model = new RunViewModel(ROOT);
    for (const event of [
      step("step-started", 1, ROOT, null),
      step("step-started", 2, "p1", null),
      passStarted(3, null, 1),
      step("step-started", 4, "leaf", "leaf"),
      step("step-finished", 5, "leaf", "leaf"),
      step("step-finished", 6, "p1", null),
      step("step-started", 7, "p2", "goto-g"),
      passStarted(8, "goto-g", 2),
      step("step-finished", 9, "p2", "goto-g"),
      step("step-finished", 10, ROOT, null),
    ]) {
      model.applyEvent(event);
    }
    const { narrative, runs } = model.getState();

    expect(narrativeRows(narrative, runs).map((event) => event.seq)).toEqual([1, 3, 4, 5, 8, 10]);
  });

  it("keeps every row of a file without goto passes", () => {
    const model = new RunViewModel(ROOT);
    model.applyEvent(step("step-started", 1, ROOT, null));
    model.applyEvent(step("step-started", 2, "leaf", "leaf"));
    model.applyEvent(step("step-finished", 3, "leaf", "leaf"));
    model.applyEvent(step("step-finished", 4, ROOT, null));
    const { narrative, runs } = model.getState();

    expect(narrativeRows(narrative, runs)).toHaveLength(4);
  });
});
