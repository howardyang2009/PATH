import type { RunNodeState } from "@path/client-core";
import { describe, expect, it } from "vitest";
import { projectRunStatus } from "../src/run/run-projection.js";

/** A minimal run record — only the fields `projectRunStatus` reads matter; the rest are inert nulls. */
function run(partial: Partial<RunNodeState> & { runId: string }): RunNodeState {
  return {
    runId: partial.runId,
    rootRunId: "root",
    parentRunId: partial.parentRunId ?? null,
    nodeId: partial.nodeId ?? null,
    nodeName: null,
    workerName: null,
    iteration: null,
    status: partial.status ?? "pending",
    startedAt: partial.startedAt ?? null,
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

  it("projects `awaiting` for a running node that holds an awaiting run below it", () => {
    // A `workflow` step's run is the nested run's root (ADR 0038): it stays `running` while a leaf in the
    // sub-workflow parks, so the node reads `awaiting` — the same repaint every other run surface shows.
    const projected = projectRunStatus(
      mapOf(
        run({ runId: "sub-root", nodeId: "revise", status: "running" }),
        run({ runId: "leaf", nodeId: "approve", parentRunId: "sub-root", status: "awaiting" }),
      ),
    );
    expect(projected.get("revise")).toBe("awaiting");
    expect(projected.get("approve")).toBe("awaiting");
  });
});
