import type { RunRecord, RunStatus, WorkflowFile, WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import {
  isAwaiting,
  isCancellable,
  isInFlight,
  type RunRowActionsInput,
  runRowActions,
} from "../src/run-affordances.js";

function run(runId: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    rootRunId: "root",
    parentRunId: "root",
    nodeId: runId,
    nodeName: runId,
    workerName: null,
    iteration: null,
    pass: null,
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
  return new Map(runs.map((row) => [row.runId, row]));
}

function file(body: WorkflowNode[]): WorkflowFile {
  return { format: "0", id: "wf-1", name: "wf", body } as unknown as WorkflowFile;
}

function leaf(id: string): WorkflowNode {
  return { type: "binary", id, name: id, command: "echo" } as unknown as WorkflowNode;
}

function input(over: Partial<RunRowActionsInput> = {}): RunRowActionsInput {
  return {
    status: "succeeded",
    displayStatus: "succeeded",
    resumeFrom: null,
    ...over,
  };
}

describe("run status predicates", () => {
  it.each([
    ["running", true],
    ["awaiting", true],
    ["pending", false],
    ["succeeded", false],
    ["failed", false],
    ["cancelled", false],
  ] as const)("isInFlight(%s) is %s", (status, expected) => {
    expect(isInFlight(status)).toBe(expected);
  });

  it.each([
    ["pending", true],
    ["running", true],
    ["awaiting", true],
    ["succeeded", false],
    ["failed", false],
    ["cancelled", false],
  ] as const)("isCancellable(%s) is %s", (status, expected) => {
    expect(isCancellable(status)).toBe(expected);
  });

  it("only awaiting is awaiting", () => {
    const statuses: RunStatus[] = [
      "pending",
      "running",
      "awaiting",
      "succeeded",
      "failed",
      "cancelled",
    ];
    expect(statuses.filter(isAwaiting)).toEqual(["awaiting"]);
  });
});

describe("runRowActions", () => {
  it("offers nothing on a live row", () => {
    const actions = runRowActions(input({ status: "running", displayStatus: "running" }));
    expect(actions.inFlight).toBe(true);
    expect(actions.delete.show).toBe(false);
    expect(actions.resume.show).toBe(false);
    expect(actions.resumeFrom.show).toBe(false);
  });

  it("reads a parked root as in flight through the display status", () => {
    // The stored root is `running`, its parked leaf makes the display status `awaiting` (ADR 0038).
    const actions = runRowActions(input({ status: "running", displayStatus: "awaiting" }));
    expect(actions.inFlight).toBe(true);
    expect(actions.delete.show).toBe(false);
  });

  it("enables plain Resume on a failed row and shows Delete", () => {
    const actions = runRowActions(input({ status: "failed", displayStatus: "failed" }));
    expect(actions.resume).toEqual({ show: true, enabled: true, reason: null });
    expect(actions.delete.show).toBe(true);
  });

  it("keeps Resume shown but greyed on a succeeded row, with its reason", () => {
    const actions = runRowActions(input());
    expect(actions.resume.show).toBe(true);
    expect(actions.resume.enabled).toBe(false);
    expect(actions.resume.reason).toEqual({ key: "shared.resumeActions.succeededReason" });
  });

  it("offers no resume-from while the watched tree has no selection", () => {
    const actions = runRowActions(
      input({
        resumeFrom: {
          rootRunId: "root",
          runs: mapOf(rootRow(), run("a")),
          rootFile: file([leaf("a")]),
          selectedRunId: null,
          dirty: false,
        },
      }),
    );
    expect(actions.resumeFrom.show).toBe(true);
    expect(actions.resumeFrom.enabled).toBe(false);
    expect(actions.eligibility).toMatchObject({ ok: false, reason: "no-selection" });
  });

  it("enables resume-from on a legal K and a clean buffer", () => {
    const actions = runRowActions(
      input({
        resumeFrom: {
          rootRunId: "root",
          runs: mapOf(rootRow(), run("a")),
          rootFile: file([leaf("a")]),
          selectedRunId: "a",
          dirty: false,
        },
      }),
    );
    expect(actions.eligibility).toMatchObject({ ok: true, runId: "a" });
    expect(actions.resumeFrom).toEqual({ show: true, enabled: true });
  });

  it("greys resume-from on a legal K over a dirty buffer", () => {
    const actions = runRowActions(
      input({
        resumeFrom: {
          rootRunId: "root",
          runs: mapOf(rootRow(), run("a")),
          rootFile: file([leaf("a")]),
          selectedRunId: "a",
          dirty: true,
        },
      }),
    );
    expect(actions.eligibility).toMatchObject({ ok: false, reason: "dirty-buffer" });
    expect(actions.resumeFrom.enabled).toBe(false);
  });

  it("shuts the resume-from door on a live watched row", () => {
    const actions = runRowActions(
      input({
        status: "running",
        displayStatus: "running",
        resumeFrom: {
          rootRunId: "root",
          runs: mapOf(rootRow(), run("a")),
          rootFile: file([leaf("a")]),
          selectedRunId: "a",
          dirty: false,
        },
      }),
    );
    expect(actions.eligibility).toBeNull();
    expect(actions.resumeFrom.show).toBe(false);
  });
});
