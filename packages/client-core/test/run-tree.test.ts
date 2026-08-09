import { describe, expect, it } from "vitest";
import { buildRunTree } from "../src/run-tree.js";
import type { RunNodeState } from "../src/view-model.js";

function run(runId: string, parentRunId: string | null, startedAt: string | null = "2026-07-25T10:00:00.000Z"): RunNodeState {
  return {
    runId,
    rootRunId: "root",
    parentRunId,
    nodeId: runId,
    nodeName: runId,
    worker: null,
    status: "running",
    startedAt,
    finishedAt: null,
    inputRef: null,
    outputRef: null,
  };
}

function mapOf(...runs: RunNodeState[]): ReadonlyMap<string, RunNodeState> {
  return new Map(runs.map((r) => [r.runId, r]));
}

/** The tree as ids, so a shape assertion reads as a shape. */
function shape(node: { run: RunNodeState; children: { run: RunNodeState; children: unknown[] }[] } | null): unknown {
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
      mapOf(run("root", null), run("waiting", "root", null), run("started", "root", "2026-07-25T10:00:01.000Z")),
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
    const tree = buildRunTree("root", mapOf(run("root", null), run("b", "root", same), run("a", "root", same)));

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
