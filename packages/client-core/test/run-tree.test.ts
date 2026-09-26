import type { RunStatus } from "@path/schema";
import { describe, expect, it } from "vitest";
import { buildRunTree, displayStatusByRun } from "../src/run-tree.js";
import type { RunNodeState } from "../src/view-model.js";

function run(
  runId: string,
  parentRunId: string | null,
  startedAt: string | null = "2026-07-25T10:00:00.000Z",
  status: RunStatus = "running",
): RunNodeState {
  return {
    runId,
    rootRunId: "root",
    parentRunId,
    nodeId: runId,
    nodeName: runId,
    workerName: null,
    iteration: null,
    pass: null,
    status,
    startedAt,
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

function mapOf(...runs: RunNodeState[]): ReadonlyMap<string, RunNodeState> {
  return new Map(runs.map((r) => [r.runId, r]));
}

/** The tree as ids, so a shape assertion reads as a shape. */
function shape(
  node: { run: RunNodeState; children: { run: RunNodeState; children: unknown[] }[] } | null,
): unknown {
  if (!node) return null;
  return { id: node.run.runId, children: node.children.map((child) => shape(child as never)) };
}

describe("buildRunTree", () => {
  it("has nothing to render when the root run is not in the map", () => {
    expect(buildRunTree("root", mapOf(run("child", "root")))).toBeNull();
  });

  it("nests each run under the run that spawned it", () => {
    const tree = buildRunTree(
      "root",
      mapOf(run("root", null), run("nested", "root"), run("leaf", "nested")),
    );

    expect(shape(tree)).toEqual({
      id: "root",
      children: [{ id: "nested", children: [{ id: "leaf", children: [] }] }],
    });
  });

  // The event stream runs ahead of the last tree read, so a child can name a parent the map has
  // not seen yet. Dropping it would make a run vanish from the tree mid-run.
  it("hangs a run whose parent is not in the map off the root", () => {
    const tree = buildRunTree("root", mapOf(run("root", null), run("orphan", "not-here")));

    expect(shape(tree)).toEqual({ id: "root", children: [{ id: "orphan", children: [] }] });
  });

  it("orders siblings by when they started, oldest first", () => {
    const tree = buildRunTree(
      "root",
      mapOf(
        run("root", null),
        run("second", "root", "2026-07-25T10:00:02.000Z"),
        run("first", "root", "2026-07-25T10:00:01.000Z"),
      ),
    );

    expect(shape(tree)).toEqual({
      id: "root",
      children: [
        { id: "first", children: [] },
        { id: "second", children: [] },
      ],
    });
  });

  it("sorts a run that has not started yet last, however the map is ordered", () => {
    const tree = buildRunTree(
      "root",
      mapOf(
        run("root", null),
        run("waiting", "root", null),
        run("started", "root", "2026-07-25T10:00:01.000Z"),
      ),
    );

    expect(shape(tree)).toEqual({
      id: "root",
      children: [
        { id: "started", children: [] },
        { id: "waiting", children: [] },
      ],
    });
  });

  // Two renders of the same data must agree, and two runs can share a start timestamp.
  it("breaks a tie on the run id, so the order is stable", () => {
    const same = "2026-07-25T10:00:01.000Z";
    const tree = buildRunTree(
      "root",
      mapOf(run("root", null), run("b", "root", same), run("a", "root", same)),
    );

    expect(shape(tree)).toEqual({
      id: "root",
      children: [
        { id: "a", children: [] },
        { id: "b", children: [] },
      ],
    });
  });

  // No engine-produced tree contains one — every run has exactly one parent, the run that started
  // it — so the walk from the root simply never reaches the pair, rather than looping forever.
  it("terminates on a parent cycle, which only hand-built data can hold", () => {
    const tree = buildRunTree("root", mapOf(run("root", null), run("a", "b"), run("b", "a")));

    expect(shape(tree)).toEqual({ id: "root", children: [] });
  });
});

describe("displayStatusByRun", () => {
  const ts = "2026-07-25T10:00:00.000Z";

  it("returns `awaiting` for a running run with an awaiting run anywhere below it", () => {
    const runs = mapOf(
      run("root", null),
      run("mid", "root", ts),
      run("leaf", "mid", ts, "awaiting"),
    );
    const display = displayStatusByRun(runs);

    // Both running ancestors read awaiting through the one shared derivation.
    expect(display.get("root")).toBe("awaiting");
    expect(display.get("mid")).toBe("awaiting");
    expect(display.get("leaf")).toBe("awaiting");
  });

  it("returns the record status when no descendant is awaiting", () => {
    const runs = mapOf(run("root", null), run("mid", "root", ts));
    expect(displayStatusByRun(runs).get("root")).toBe("running");
  });

  it("returns a run's own status untouched when it is not running", () => {
    // An awaiting leaf reports awaiting directly; a terminal or pending run is never repainted.
    const runs = mapOf(run("root", null, ts, "succeeded"), run("leaf", "root", ts, "awaiting"));
    const display = displayStatusByRun(runs);
    expect(display.get("leaf")).toBe("awaiting");
    expect(display.get("root")).toBe("succeeded");
    expect(displayStatusByRun(mapOf(run("root", null, ts, "pending"))).get("root")).toBe("pending");
  });

  it("derives only from the given map, so a map without descendants leaves the status unchanged", () => {
    // The runs list holds only summaries for the runs it is not watching: no descendants, no repaint.
    expect(displayStatusByRun(mapOf(run("root", null))).get("root")).toBe("running");
  });

  it("flips only the branch that holds the awaiting leaf", () => {
    const runs = mapOf(
      run("root", null),
      run("branch-a", "root", ts),
      run("leaf-a", "branch-a", ts, "awaiting"),
      run("branch-b", "root", ts),
      run("leaf-b", "branch-b", ts, "running"),
    );
    const display = displayStatusByRun(runs);

    expect(display.get("branch-a")).toBe("awaiting");
    expect(display.get("branch-b")).toBe("running");
  });

  it("carries the display status onto each tree node", () => {
    const tree = buildRunTree(
      "root",
      mapOf(run("root", null), run("leaf", "root", ts, "awaiting")),
    );

    expect(tree?.displayStatus).toBe("awaiting");
    expect(tree?.children[0]?.displayStatus).toBe("awaiting");
  });
});
