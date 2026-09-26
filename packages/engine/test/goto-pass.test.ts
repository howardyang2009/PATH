import type { GotoNode, JsonValue, RunRecord, WorkflowFile, WorkflowNode } from "@path/schema";
import { FORMAT_VERSION } from "@path/schema";
import { describe, expect, it } from "vitest";
import { passFirstNode, passWalkStart, recordedPasses } from "../src/goto-pass.js";
import type { ContinueState } from "../src/run-context.js";

/**
 * The goto pass module (`goto-pass.ts`) through its own interface: where a top-level walk starts for a
 * launch, a Resume and a Complete (ADR 0060), over in-memory rows and no store.
 */

function run(
  overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "parentRunId" | "nodeId" | "status">,
): RunRecord {
  return {
    rootRunId: "root",
    nodeName: overrides.nodeId,
    workerName: null,
    iteration: null,
    pass: null,
    startedAt: "t0",
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
    ...overrides,
  };
}

const step = (id: string): WorkflowNode => ({ type: "binary", id, name: id, command: "echo" });
const check: GotoNode = {
  type: "goto",
  id: "check",
  name: "check",
  target: "review",
  max_jumps: 3,
};
const reviewSequence: WorkflowNode = {
  type: "sequence",
  id: "review",
  name: "review",
  body: [step("draft"), step("lint")],
};
const file: WorkflowFile = {
  format: FORMAT_VERSION,
  id: "11111111-1111-4111-8111-111111111111",
  name: "t",
  body: [step("intake"), reviewSequence, check],
};
const gotos = new Map([["check", check]]);
const identity = {
  runId: "root",
  rootRunId: "root",
  parentRunId: null,
  nodeId: null,
  nodeName: null,
};

function continueState(existingRuns: RunRecord[]): ContinueState {
  return {
    existingRuns,
    readBlob: (r, filename) => ({ blob: `${r.runId}/${filename}` }) as JsonValue,
    target: { stepRunId: "leaf", output: {} },
  };
}

describe("passFirstNode", () => {
  it("looks through a sequence target to its first recorded node (ADR 0064)", () => {
    expect(passFirstNode(reviewSequence)?.id).toBe("draft");
    expect(passFirstNode(step("intake"))?.id).toBe("intake");
  });
});

describe("passWalkStart", () => {
  it("starts a launch at pass 1 from the top, with no jumps spent", () => {
    const walk = passWalkStart({ file, identity }, gotos, { seed: 1 });
    expect(walk).toMatchObject({
      pass: 1,
      opener: null,
      start: 0,
      carried: { seed: 1 },
      reentered: undefined,
    });
    if ("diverged" in walk) throw new Error("unexpected divergence");
    expect(walk.jumpsSpent.size).toBe(0);
    expect(walk.resumeFor(1, null)).toBeUndefined();
  });

  it("re-enters a Complete's running pass at its goto's target, counting every recorded pass as a jump", () => {
    const rows = [
      run({ runId: "p1", parentRunId: "root", nodeId: null, pass: 1, status: "succeeded" }),
      run({ runId: "p2", parentRunId: "root", nodeId: "check", pass: 2, status: "succeeded" }),
      run({ runId: "p3", parentRunId: "root", nodeId: "check", pass: 3, status: "running" }),
      run({ runId: "p3-draft", parentRunId: "p3", nodeId: "draft", status: "succeeded" }),
    ];
    const walk = passWalkStart({ file, identity, continue: continueState(rows) }, gotos, {});
    if ("diverged" in walk) throw new Error(walk.error);
    expect(walk).toMatchObject({
      pass: 3,
      opener: check,
      start: 1,
      carried: { blob: "p3/input.json" },
      reentered: rows[2],
    });
    expect(walk.jumpsSpent.get("check")).toBe(2);
  });

  it("fails a Complete whose running pass no longer opens at the node it recorded first", () => {
    const rows = [
      run({ runId: "p1", parentRunId: "root", nodeId: null, pass: 1, status: "succeeded" }),
      run({ runId: "p2", parentRunId: "root", nodeId: "check", pass: 2, status: "running" }),
      run({ runId: "p2-intake", parentRunId: "p2", nodeId: "intake", status: "succeeded" }),
    ];
    const walk = passWalkStart({ file, identity, continue: continueState(rows) }, gotos, {});
    expect(walk).toMatchObject({ diverged: rows[1] });
    expect("error" in walk && walk.error).toContain('recorded "intake"');
  });
});

describe("recordedPasses", () => {
  it("lists one run's pass rows in ordinal order", () => {
    const rows = [
      run({ runId: "p2", parentRunId: "root", nodeId: "check", pass: 2, status: "succeeded" }),
      run({ runId: "x", parentRunId: "root", nodeId: "intake", status: "succeeded" }),
      run({ runId: "p1", parentRunId: "root", nodeId: null, pass: 1, status: "succeeded" }),
    ];
    expect(recordedPasses(rows, "root").map((r) => r.runId)).toEqual(["p1", "p2"]);
  });
});
