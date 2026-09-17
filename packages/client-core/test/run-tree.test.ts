import { describe, expect, it } from "vitest";
import { awaitingAncestorRunIds, buildRunTree } from "../src/run-tree.js";
import type { RunStatus } from "@path/schema";
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

describe("awaitingAncestorRunIds", () => {
  const ts = "2026-07-25T10:00:00.000Z";

  it("returns the running ancestors of an awaiting leaf, up to the root", () => {
    const tree = buildRunTree(
      "root",
      mapOf(run("root", null), run("mid", "root", ts), run("leaf", "mid", ts, "awaiting")),
    )!;

    // Both running ancestors flip; the awaiting leaf itself is not in the set (it needs no derivation).
    expect([...awaitingAncestorRunIds(tree)].sort()).toEqual(["mid", "root"]);
  });

  it("is empty when no run in the tree is awaiting", () => {
    const tree = buildRunTree("root", mapOf(run("root", null), run("mid", "root", ts)))!;
    expect(awaitingAncestorRunIds(tree).size).toBe(0);
  });

  it("never flips a terminal ancestor, only a running one", () => {
    // A succeeded parent with an awaiting child (a shape ADR 0038 does not produce, but the derivation
    // must not invent an awaiting on a finished run regardless).
    const tree = buildRunTree(
      "root",
      mapOf(run("root", null), run("done", "root", ts, "succeeded"), run("leaf", "done", ts, "awaiting")),
    )!;

    expect([...awaitingAncestorRunIds(tree)]).toEqual(["root"]);
  });

  it("flips only the branch that holds the awaiting leaf", () => {
    const tree = buildRunTree(
      "root",
      mapOf(
        run("root", null),
        run("branch-a", "root", ts),
        run("leaf-a", "branch-a", ts, "awaiting"),
        run("branch-b", "root", ts),
        run("leaf-b", "branch-b", ts, "running"),
      ),
    )!;

    const ids = awaitingAncestorRunIds(tree);
    expect(ids.has("root")).toBe(true);
    expect(ids.has("branch-a")).toBe(true);
    expect(ids.has("branch-b")).toBe(false);
  });
});
