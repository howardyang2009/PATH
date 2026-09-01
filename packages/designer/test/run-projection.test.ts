import type { RunNodeState } from "@path/client-core";
import { describe, expect, it } from "vitest";
import { projectRunStatus } from "../src/run/run-projection.js";

/** A minimal run record — only the fields `projectRunStatus` reads matter; the rest are inert nulls. */
function run(partial: Partial<RunNodeState> & { runId: string }): RunNodeState {
  return {
    runId: partial.runId,
    rootRunId: "root",
    parentRunId: null,
    nodeId: partial.nodeId ?? null,
    nodeName: null,
    workerName: null,
    status: partial.status ?? "pending",
    startedAt: partial.startedAt ?? null,
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    reusedFromRunId: null,
    reusedFromRootRunId: null,
    workflowId: null,
    workflowName: null,
    workflowPath: null,
  };
}

function mapOf(...runs: RunNodeState[]): Map<string, RunNodeState> {
  return new Map(runs.map((r) => [r.runId, r]));
}

describe("projectRunStatus (#372 canvas projection)", () => {
  it("keys the projection by a run's node id", () => {
    const projected = projectRunStatus(mapOf(run({ runId: "r1", nodeId: "node-a", status: "succeeded" })));
    expect(projected.get("node-a")).toBe("succeeded");
  });

  it("ignores the implicit root run, which has no node id", () => {
    const projected = projectRunStatus(mapOf(run({ runId: "root", nodeId: null, status: "running" })));
    expect(projected.size).toBe(0);
  });

  it("projects `running` when any of a node's runs is in flight (a while-do iterating)", () => {
    // Iteration 1 finished, iteration 2 is still going — the node reads as running.
    const projected = projectRunStatus(
      mapOf(
        run({ runId: "iter1", nodeId: "loop", status: "succeeded", startedAt: "2026-01-01T00:00:00Z" }),
        run({ runId: "iter2", nodeId: "loop", status: "running", startedAt: "2026-01-01T00:00:05Z" }),
      ),
    );
    expect(projected.get("loop")).toBe("running");
  });

  it("projects the most-recently-started run's status when none is in flight", () => {
    // A later iteration failed after an earlier one succeeded — the node reads as failed.
    const projected = projectRunStatus(
      mapOf(
        run({ runId: "iter1", nodeId: "loop", status: "succeeded", startedAt: "2026-01-01T00:00:00Z" }),
        run({ runId: "iter2", nodeId: "loop", status: "failed", startedAt: "2026-01-01T00:00:05Z" }),
      ),
    );
    expect(projected.get("loop")).toBe("failed");
  });
});
