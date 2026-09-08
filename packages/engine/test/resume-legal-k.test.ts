import { join } from "node:path";
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
    const verdict = resolveLegalK(abcFile, abcRows(), "b-run", new Map(), "/tmp");
    expect(verdict).toEqual({ ok: true, nodePath: ["b"] });
  });

  it("accepts the first node (empty prefix)", () => {
    expect(resolveLegalK(abcFile, abcRows(), "a-run", new Map(), "/tmp")).toEqual({ ok: true, nodePath: ["a"] });
  });
});

describe("resolveLegalK — the refusal taxonomy (spec §5)", () => {
  it("reason 1: a run id in no run of the tree is 400", () => {
    const verdict = resolveLegalK(abcFile, abcRows(), "nope", new Map(), "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(400);
    expect(verdict.refusal.message).toContain("not in the run tree");
  });

  it("the root run is never a boundary — 400", () => {
    const verdict = resolveLegalK(abcFile, abcRows(), "root", new Map(), "/tmp");
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
    const verdict = resolveLegalK(withoutB, abcRows(), "b-run", new Map(), "/tmp");
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
    const verdict = resolveLegalK(nestedB, abcRows(), "b-run", new Map(), "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(400);
    expect(verdict.refusal.message).toContain("loop, parallel, or branch");
  });

  it("reason 4: an unsucceeded K node is 409", () => {
    const verdict = resolveLegalK(abcFile, abcRows({ b: "failed" }), "b-run", new Map(), "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("did not succeed");
  });

  it("reason 5: a broken prefix before a succeeded K is 409", () => {
    // K = c succeeded, but b before it did not — the prefix cannot be reused.
    const verdict = resolveLegalK(abcFile, abcRows({ b: "failed" }), "c-run", new Map(), "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("prefix");
  });

  it("reports K-not-succeeded (#4) before a broken prefix (#5) when both fail", () => {
    // K = b failed AND a before it failed. The dependency order is #4 before #5, so the reason is
    // the boundary's own failure, not the prefix.
    const verdict = resolveLegalK(abcFile, abcRows({ a: "failed", b: "failed" }), "b-run", new Map(), "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.message).toContain("did not succeed");
    expect(verdict.refusal.message).not.toContain("prefix");
  });

  it("a reuse-row K is legal (a reuse row is written succeeded)", () => {
    const rows = abcRows();
    // b is a reuse row (#257): status succeeded, pointing at a source run in another tree.
    rows[2] = run({
      runId: "b-run",
      parentRunId: "root",
      nodeId: "b",
      status: "succeeded",
      reusedFromRunId: "src-run",
      reusedFromRootRunId: "src-root",
    });
    expect(resolveLegalK(abcFile, rows, "b-run", new Map(), "/tmp")).toEqual({ ok: true, nodePath: ["b"] });
  });
});

// Root [a, sub→nested, d]; nested [p, k, q]. K = k inside sub, reached by the descent path [sub, k].
const NESTED_PATH = join("/tmp", "nested.workflow.json");
const nestedFile = tree([
  { type: "prompt", id: "p", name: "p", prompt: "p" },
  { type: "prompt", id: "k", name: "k", prompt: "k" },
  { type: "prompt", id: "q", name: "q", prompt: "q" },
]);
const rootWithSub = tree([
  { type: "prompt", id: "a", name: "a", prompt: "a" },
  { type: "workflow", id: "sub", name: "sub", ref: "./nested.workflow.json", input: {} },
  { type: "prompt", id: "d", name: "d", prompt: "d" },
]);
const nestedFiles = new Map([[NESTED_PATH, nestedFile]]);

function nestedRows(
  over: { sub?: RunRecord["status"]; p?: RunRecord["status"]; k?: RunRecord["status"]; q?: RunRecord["status"] } = {},
): RunRecord[] {
  return [
    run({ runId: "root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
    run({ runId: "a-run", parentRunId: "root", nodeId: "a", status: "succeeded" }),
    run({ runId: "sub-run", parentRunId: "root", nodeId: "sub", status: over.sub ?? "failed" }),
    run({ runId: "p-run", parentRunId: "sub-run", nodeId: "p", status: over.p ?? "succeeded" }),
    run({ runId: "k-run", parentRunId: "sub-run", nodeId: "k", status: over.k ?? "succeeded" }),
    run({ runId: "q-run", parentRunId: "sub-run", nodeId: "q", status: over.q ?? "failed" }),
    run({ runId: "d-run", parentRunId: "root", nodeId: "d", status: "failed" }),
  ];
}

describe("resolveLegalK — a nested descent path (ADR 0036)", () => {
  it("resolves a nested K by walking the run's parents to root", () => {
    // sub itself failed (a later node re-runs), but K = k succeeded with a succeeded inner prefix p.
    const verdict = resolveLegalK(rootWithSub, nestedRows(), "k-run", nestedFiles, "/tmp");
    expect(verdict).toEqual({ ok: true, nodePath: ["sub", "k"] });
  });

  it("a since-deleted intermediate workflow is 409", () => {
    const withoutSub = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a" },
      { type: "prompt", id: "d", name: "d", prompt: "d" },
    ]);
    const verdict = resolveLegalK(withoutSub, nestedRows(), "k-run", nestedFiles, "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("no longer in the workflow");
  });

  it("an intermediate node that is no longer a nested workflow is 409", () => {
    const subNotWorkflow = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a" },
      { type: "prompt", id: "sub", name: "sub", prompt: "sub" },
      { type: "prompt", id: "d", name: "d", prompt: "d" },
    ]);
    const verdict = resolveLegalK(subNotWorkflow, nestedRows(), "k-run", nestedFiles, "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("no longer a nested workflow");
  });

  it("a broken prefix one level down (before K inside sub) is 409", () => {
    // p (before k, inside sub) did not succeed — the inner prefix cannot be reused.
    const verdict = resolveLegalK(rootWithSub, nestedRows({ p: "failed" }), "k-run", nestedFiles, "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("prefix");
  });

  it("an unsucceeded nested K is 409", () => {
    const verdict = resolveLegalK(rootWithSub, nestedRows({ k: "failed" }), "k-run", nestedFiles, "/tmp");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.refusal.status).toBe(409);
    expect(verdict.refusal.message).toContain("did not succeed");
  });
});

// The refusal's machine `reason` (and, for an in-body locus, the `container`) is what the
// `--list-eligible` listing renders its 1:1 short cell from (#446, spec §6) — the same authority a
// `--from` refusal carries, so the column can never disagree with `--from`. This pins each code.
describe("resolveLegalK — the refusal reason code (spec §6)", () => {
  function refusalOf(...args: Parameters<typeof resolveLegalK>) {
    const verdict = resolveLegalK(...args);
    if (verdict.ok) throw new Error("expected a refusal");
    return verdict.refusal;
  }

  it("the root run is reason `root-run`", () => {
    expect(refusalOf(abcFile, abcRows(), "root", new Map(), "/tmp").reason).toBe("root-run");
  });

  it("a since-deleted top-level node is reason `not-in-file`", () => {
    const withoutB = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a" },
      { type: "prompt", id: "c", name: "c", prompt: "c" },
    ]);
    expect(refusalOf(withoutB, abcRows(), "b-run", new Map(), "/tmp").reason).toBe("not-in-file");
  });

  it("an unsucceeded K is reason `not-succeeded`", () => {
    expect(refusalOf(abcFile, abcRows({ b: "failed" }), "b-run", new Map(), "/tmp").reason).toBe("not-succeeded");
  });

  it("a broken prefix is reason `prefix-unsucceeded`", () => {
    expect(refusalOf(abcFile, abcRows({ b: "failed" }), "c-run", new Map(), "/tmp").reason).toBe("prefix-unsucceeded");
  });

  it("a node inside a while-do body is reason `in-body` with container `loop`", () => {
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
    const refusal = refusalOf(nestedB, abcRows(), "b-run", new Map(), "/tmp");
    expect(refusal.reason).toBe("in-body");
    expect(refusal.container).toBe("loop");
  });

  it("a node inside a parallel branch is reason `in-body` with container `parallel`", () => {
    const nestedB = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a" },
      {
        type: "parallel",
        id: "par",
        name: "par",
        branches: [{ type: "prompt", id: "b", name: "b", prompt: "b" }],
      },
    ]);
    const refusal = refusalOf(nestedB, abcRows(), "b-run", new Map(), "/tmp");
    expect(refusal.reason).toBe("in-body");
    expect(refusal.container).toBe("parallel");
  });

  it("a node inside a branch arm is reason `in-body` with container `branch`", () => {
    const nestedB = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a" },
      {
        type: "branch",
        id: "br",
        name: "br",
        arms: [{ when: { type: "exists", path: "context.x" }, node: { type: "prompt", id: "b", name: "b", prompt: "b" } }],
      },
    ]);
    const refusal = refusalOf(nestedB, abcRows(), "b-run", new Map(), "/tmp");
    expect(refusal.reason).toBe("in-body");
    expect(refusal.container).toBe("branch");
  });
});
