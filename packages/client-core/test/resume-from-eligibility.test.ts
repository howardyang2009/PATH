import type { RunRecord, RunStatus, WorkflowFile, WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import { resumeFromEligibility, shortRunId } from "../src/resume-from-eligibility.js";

/** A run row, defaulting to a succeeded leaf under the root run. */
function run(runId: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    rootRunId: "root",
    parentRunId: "root",
    nodeId: runId,
    nodeName: runId,
    workerName: null,
    iteration: null,
    status: "succeeded",
    startedAt: "2026-07-25T10:00:00.000Z",
    finishedAt: "2026-07-25T10:00:01.000Z",
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
    ...over,
  };
}

function rootRow(): RunRecord {
  return run("root", { parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" });
}

function mapOf(...runs: RunRecord[]): ReadonlyMap<string, RunRecord> {
  return new Map(runs.map((r) => [r.runId, r]));
}

/** A leaf `binary` node with the given id (its name equals its id, matching the run rows above). */
function leaf(id: string): WorkflowNode {
  return { type: "binary", id, name: id, command: "echo" } as unknown as WorkflowNode;
}

function file(body: WorkflowNode[]): WorkflowFile {
  return { format: "0", id: "wf-1", name: "wf", body } as unknown as WorkflowFile;
}

const CLEAN = false;
const DIRTY = true;

describe("shortRunId", () => {
  it("takes the first eight characters", () => {
    expect(shortRunId("f427cca4-1111-2222-3333-444444444444")).toBe("f427cca4");
  });
});

describe("resumeFromEligibility precedence", () => {
  it("(1) reports no-selection when nothing is selected", () => {
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("a")),
      rootFile: file([leaf("a")]),
      selectedRunId: null,
      dirty: CLEAN,
    });
    expect(result).toEqual({ ok: false, reason: "no-selection", message: "Select a node in the run tree." });
  });

  it("(1) folds the root row into no-selection — the root run is never a K", () => {
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("a")),
      rootFile: file([leaf("a")]),
      selectedRunId: "root",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: false, reason: "no-selection" });
  });

  it("(2) an illegal K outranks a dirty buffer", () => {
    // A not-succeeded K over a dirty buffer shows the illegal-K reason, not the save-first one.
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("a", { status: "failed" })),
      rootFile: file([leaf("a")]),
      selectedRunId: "a",
      dirty: DIRTY,
    });
    expect(result).toMatchObject({ ok: false, reason: "not-succeeded" });
  });

  it("(3) a legal K over a dirty buffer is disabled with Save to enable", () => {
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("a")),
      rootFile: file([leaf("a")]),
      selectedRunId: "a",
      dirty: DIRTY,
    });
    expect(result).toEqual({ ok: false, reason: "dirty-buffer", message: "Save to enable." });
  });
});

describe("resumeFromEligibility legal K", () => {
  it("enables a succeeded top-level K with the label parts", () => {
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("fetchdata-run-1234")),
      rootFile: file([leaf("fetchdata-run-1234")]),
      selectedRunId: "fetchdata-run-1234",
      dirty: CLEAN,
    });
    expect(result).toEqual({
      ok: true,
      runId: "fetchdata-run-1234",
      nodeName: "fetchdata-run-1234",
      shortRunId: "fetchdat",
    });
  });

  it("treats a succeeded reuse row as a legal K", () => {
    const reuse = run("b", { reusedFromRunId: "orig", reusedFromRootRunId: "prevroot", status: "succeeded" });
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("a"), reuse),
      rootFile: file([leaf("a"), leaf("b")]),
      selectedRunId: "b",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: true, runId: "b" });
  });

  it("enables a nested K on its own success alone (the engine backstops the rest)", () => {
    // A run under a nested workflow-run, whose file the Designer does not hold: succeeded ⇒ optimistic.
    const nested = run("wf-run", { nodeId: "wf-node", nodeName: "wf-node" });
    const inner = run("inner", { parentRunId: "wf-run", status: "succeeded" });
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), nested, inner),
      rootFile: file([leaf("wf-node")]),
      selectedRunId: "inner",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: true, runId: "inner" });
  });
});

describe("resumeFromEligibility taxonomy (root level)", () => {
  it("#4 not-succeeded — the K itself did not reach succeeded", () => {
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("a", { status: "failed" })),
      rootFile: file([leaf("a")]),
      selectedRunId: "a",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: false, reason: "not-succeeded" });
  });

  it("#5 prefix-unsucceeded — a node before K did not succeed", () => {
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("a", { status: "failed" }), run("b")),
      rootFile: file([leaf("a"), leaf("b")]),
      selectedRunId: "b",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: false, reason: "prefix-unsucceeded" });
  });

  it("#2 not-in-file — K resolves to a node no longer in the file", () => {
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("gone")),
      rootFile: file([leaf("a")]),
      selectedRunId: "gone",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: false, reason: "not-in-file" });
  });

  it("#3 in-body — K is inside a while-do body, named as a loop", () => {
    const loopNode = {
      type: "while-do",
      id: "loop",
      name: "loop",
      condition: { path: "context.go", predicate: "is-true" },
      node: leaf("inner"),
    } as unknown as WorkflowNode;
    // `inner` ran under the root scope (control nodes own no run row), so its run's parent is the root.
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("inner")),
      rootFile: file([loopNode]),
      selectedRunId: "inner",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: false, reason: "in-body", container: "loop" });
  });

  it("checks the leaf's success (#4) before the prefix (#5), matching the engine order", () => {
    // Both K and its prefix failed: the reason shown is the leaf's own, per taxonomy dependency order.
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("a", { status: "failed" }), run("b", { status: "failed" })),
      rootFile: file([leaf("a"), leaf("b")]),
      selectedRunId: "b",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: false, reason: "not-succeeded" });
  });
});

describe("resumeFromEligibility #5 — a skipped prefix path is not a broken one", () => {
  /** A `branch` whose arms' `node`s never run under the control node itself (they run under the root). */
  function branch(id: string, ...armNodes: WorkflowNode[]): WorkflowNode {
    return {
      type: "branch",
      id,
      name: id,
      arms: armNodes.map((node) => ({ when: { path: "context.x", predicate: "is-true" }, node })),
    } as unknown as WorkflowNode;
  }

  it("an untaken branch arm before K does not break the prefix — the arm never ran", () => {
    // The prefix is a branch: `taken` ran and succeeded, `untaken` has no run at all. K = write after it.
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("taken"), run("write")),
      rootFile: file([branch("pick", leaf("taken"), leaf("untaken")), leaf("write")]),
      selectedRunId: "write",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: true, runId: "write" });
  });

  it("a zero-iteration while-do body before K does not break the prefix — the body never ran", () => {
    const loopNode = {
      type: "while-do",
      id: "revise-loop",
      name: "revise-loop",
      condition: { path: "context.go", predicate: "is-true" },
      node: leaf("revise"),
    } as unknown as WorkflowNode;
    // `revise` (the loop body) has no run row: the loop ran zero iterations, yet the run still succeeded.
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("write")),
      rootFile: file([loopNode, leaf("write")]),
      selectedRunId: "write",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: true, runId: "write" });
  });

  it("a branch arm that ran and failed still breaks the prefix (only skipped paths are excused)", () => {
    const result = resumeFromEligibility({
      rootRunId: "root",
      runs: mapOf(rootRow(), run("taken", { status: "failed" }), run("write")),
      rootFile: file([branch("pick", leaf("taken"), leaf("untaken")), leaf("write")]),
      selectedRunId: "write",
      dirty: CLEAN,
    });
    expect(result).toMatchObject({ ok: false, reason: "prefix-unsucceeded" });
  });
});
