import type { RunRecord, WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { resolveLegalK } from "../src/resume-legal-k.js";
import { stampNames } from "./stamp-names.js";

/**
 * The one legal-K authority (spec §5, ADR 0032): `resolveLegalK` resolves an operator's source run id
 * to the top-level rerun boundary node-id path, or refuses it with the five-reason taxonomy. This
 * suite pins each reason and each status, plus the happy path, over the same two inputs
 * `Project.resume` feeds it — the source tree's raw rows and the current file.
 */

function run(overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "parentRunId" | "nodeId" | "status">): RunRecord {
  return {
    rootRunId: "orig-root",
    nodeName: overrides.nodeId,
    workerName: null,
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

function tree(body: WorkflowFile["body"]): WorkflowFile {
  return stampNames({ format: "path/workflow@3", name: "k", config: {}, body });
}

// Three top-level prompts a,b,c, all succeeded under the root run.
const abcFile = tree([
  { type: "prompt", id: "a", name: "a", prompt: "a" },
  { type: "prompt", id: "b", name: "b", prompt: "b" },
  { type: "prompt", id: "c", name: "c", prompt: "c" },
]);

function abcRows(statuses: { a?: RunRecord["status"]; b?: RunRecord["status"]; c?: RunRecord["status"] } = {}): RunRecord[] {
  return [
    run({ runId: "root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
    run({ runId: "a-run", parentRunId: "root", nodeId: "a", status: statuses.a ?? "succeeded" }),
    run({ runId: "b-run", parentRunId: "root", nodeId: "b", status: statuses.b ?? "succeeded" }),
    run({ runId: "c-run", parentRunId: "root", nodeId: "c", status: statuses.c ?? "succeeded" }),
  ];
}

describe("resolveLegalK — the legal path", () => {
  it("resolves a top-level succeeded node with a succeeded prefix to its length-1 node path", () => {
    const verdict = resolveLegalK(abcFile, abcRows(), "b-run");
    expect(verdict).toEqual({ ok: true, nodePath: ["b"] });
  });

  it("accepts the first node (empty prefix)", () => {
    expect(resolveLegalK(abcFile, abcRows(), "a-run")).toEqual({ ok: true, nodePath: ["a"] });
  });
});

describe("resolveLegalK — the refusal taxonomy (spec §5)", () => {
  it("reason 1: a run id in no run of the tree is 400", () => {
    const verdict = resolveLegalK(abcFile, abcRows(), "nope");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(400);
    expect(verdict.refusal.message).toContain("not in the run tree");
  });

  it("the root run is never a boundary — 400", () => {
    const verdict = resolveLegalK(abcFile, abcRows(), "root");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(400);
    expect(verdict.refusal.message).toContain("root run");
  });

  it("reason 2: a since-deleted node is 409", () => {
    // The current file no longer has `b`; the operator's `b-run` selection resolves to nothing.
    const withoutB = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a" },
      { type: "prompt", id: "c", name: "c", prompt: "c" },
    ]);
    const verdict = resolveLegalK(withoutB, abcRows(), "b-run");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("no longer in the workflow");
  });

  it("reason 3: a node inside a loop/parallel/branch body is an illegal locus — 400", () => {
    // `b` is now nested inside a while-do body, so it is present but not a top-level node.
    const nestedB = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a" },
      {
        type: "while-do",
        id: "loop",
        name: "loop",
        condition: { type: "exists", path: "context.x" },
        max_iterations: 3,
        node: { type: "prompt", id: "b", name: "b", prompt: "b" },
      },
    ]);
    const verdict = resolveLegalK(nestedB, abcRows(), "b-run");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(400);
    expect(verdict.refusal.message).toContain("loop, parallel, or branch");
  });

  it("reason 4: an unsucceeded K node is 409", () => {
    const verdict = resolveLegalK(abcFile, abcRows({ b: "failed" }), "b-run");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("did not succeed");
  });

  it("reason 5: a broken prefix before a succeeded K is 409", () => {
    // K = c succeeded, but b before it did not — the prefix cannot be reused.
    const verdict = resolveLegalK(abcFile, abcRows({ b: "failed" }), "c-run");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("prefix");
  });
});
