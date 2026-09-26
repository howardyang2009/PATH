import type {
  BinaryStep,
  JsonValue,
  RunRecord,
  WorkflowFile,
  WorkflowNode,
  WorkflowStep,
} from "@path/schema";
import { FORMAT_VERSION } from "@path/schema";
import { describe, expect, it } from "vitest";
import {
  enterIteration,
  enterNested,
  passResumer,
  recordedChild,
  resolveResume,
  resumeSeed,
  rootResumeEntry,
} from "../src/resume-plan.js";
import type { ResumeInput } from "../src/run-workflow.js";

/**
 * The Resume plan module (`resume-plan.ts`) through its own interface: in-memory predecessor rows and
 * a file, no store. Every scope kind — root, nested `workflow`, `while-do` iteration, goto pass — is
 * one `enter…` operation over the same counterpart lookup and boundary path.
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

const root = run({
  runId: "root",
  parentRunId: null,
  nodeId: null,
  nodeName: null,
  status: "failed",
});

function tree(body: WorkflowNode[]): WorkflowFile {
  return { format: FORMAT_VERSION, id: "11111111-1111-4111-8111-111111111111", name: "t", body };
}

const binary = (id: string): BinaryStep => ({ type: "binary", id, name: id, command: "echo" });
const workflow = (id: string): WorkflowStep => ({
  type: "workflow",
  id,
  name: id,
  ref: "./nested.workflow.json",
});

function input(originalRuns: RunRecord[], extra: Partial<ResumeInput> = {}): ResumeInput {
  return {
    originalRuns,
    readBlob: (r, filename) => ({ blob: `${r.runId}/${filename}` }) as JsonValue,
    ...extra,
  };
}

describe("recordedChild — the one counterpart lookup", () => {
  const rows = [
    root,
    run({ runId: "a", parentRunId: "root", nodeId: "a", status: "succeeded" }),
    run({ runId: "it1", parentRunId: "root", nodeId: "loop", iteration: 1, status: "succeeded" }),
    run({ runId: "it2", parentRunId: "root", nodeId: "loop", iteration: 2, status: "failed" }),
    run({ runId: "p1", parentRunId: "root", nodeId: null, pass: 1, status: "succeeded" }),
  ];

  it("answers the one row under the parent matching the key", () => {
    expect(recordedChild(rows, "root", { nodeId: "a" })).toBe(rows[1]);
    expect(recordedChild(rows, "root", { nodeId: "loop", iteration: 2 })).toBe(rows[3]);
    expect(recordedChild(rows, "root", { nodeId: null, pass: 1 })).toBe(rows[4]);
  });

  it("answers none on zero or more than one match, and for an absent parent", () => {
    expect(recordedChild(rows, "root", { nodeId: "added-since" })).toBeUndefined();
    expect(recordedChild(rows, "root", { nodeId: "loop" })).toBeUndefined();
    expect(recordedChild(rows, undefined, { nodeId: "a" })).toBeUndefined();
  });

  it("filters to succeeded rows on request", () => {
    expect(
      recordedChild(rows, "root", { nodeId: "loop", iteration: 2, succeeded: true }),
    ).toBeUndefined();
  });
});

describe("rootResumeEntry / resolveResume / resumeSeed", () => {
  const file = tree([binary("a"), binary("b"), binary("c")]);
  const rows = [
    root,
    run({ runId: "ra", parentRunId: "root", nodeId: "a", status: "succeeded" }),
    run({ runId: "rb", parentRunId: "root", nodeId: "b", status: "succeeded" }),
    run({ runId: "rc", parentRunId: "root", nodeId: "c", status: "failed" }),
  ];

  it("pairs the root with the predecessor's root and folds the path and passes into one list", () => {
    const entry = rootResumeEntry(input(rows, { rerunFromNodePath: ["b"], rerunFromPasses: [2] }));
    expect(entry.counterpart).toBe(root);
    expect(entry.rerunPath).toEqual([{ nodeId: "b", pass: 2 }]);
  });

  it("plans plain Resume reuse of every succeeded child", () => {
    const resume = resolveResume(rootResumeEntry(input(rows)), file);
    expect([...resume.plan.keys()]).toEqual(["a", "b"]);
  });

  it("suppresses K and everything after it under Resume-from-K", () => {
    const resume = resolveResume(rootResumeEntry(input(rows, { rerunFromNodePath: ["b"] })), file);
    expect([...resume.plan.keys()]).toEqual(["a"]);
  });

  it("seeds only a resumed root from its counterpart's recorded input (ADR 0062)", () => {
    const entry = rootResumeEntry(input(rows));
    expect(resumeSeed(entry, true)).toEqual({ blob: "root/input.json" });
    expect(resumeSeed(entry, false)).toBeUndefined();
    expect(resumeSeed({ ...entry, counterpart: undefined }, true)).toBeUndefined();
    expect(resumeSeed(undefined, true)).toBeUndefined();
  });
});

describe("enterNested — Producer B's three dispositions", () => {
  const file = tree([binary("a"), workflow("w"), workflow("x")]);
  const rows = [
    root,
    run({ runId: "ra", parentRunId: "root", nodeId: "a", status: "succeeded" }),
    run({ runId: "rw", parentRunId: "root", nodeId: "w", status: "failed" }),
    run({ runId: "rx", parentRunId: "root", nodeId: "x", status: "failed" }),
  ];

  it("re-enters the counterpart with no path off-path / plain Resume", () => {
    const resume = resolveResume(rootResumeEntry(input(rows)), file);
    expect(enterNested(resume, file, "w")).toMatchObject({ counterpart: rows[2], rerunPath: [] });
  });

  it("descends the path-node with the path's tail", () => {
    const resume = resolveResume(
      rootResumeEntry(
        input(rows, { rerunFromNodePath: ["w", "inner"], rerunFromPasses: [null, 3] }),
      ),
      file,
    );
    expect(enterNested(resume, file, "w")).toMatchObject({
      counterpart: rows[2],
      rerunPath: [{ nodeId: "inner", pass: 3 }],
    });
  });

  it("re-runs a node after the boundary entire, with no counterpart", () => {
    const resume = resolveResume(
      rootResumeEntry(input(rows, { rerunFromNodePath: ["w", "inner"] })),
      file,
    );
    expect(enterNested(resume, file, "x")).toMatchObject({ counterpart: undefined, rerunPath: [] });
  });

  it("is undefined for a run that is not resuming", () => {
    expect(enterNested(undefined, file, "w")).toBeUndefined();
  });
});

describe("enterIteration — a while-do iteration container", () => {
  const loop: WorkflowNode = {
    type: "while-do",
    id: "loop",
    name: "loop",
    condition: { type: "exists", path: "context.more" },
    max_iterations: 3,
    node: binary("body"),
  };
  const file = tree([loop, binary("after")]);
  const rows = [
    root,
    run({ runId: "it1", parentRunId: "root", nodeId: "loop", iteration: 1, status: "succeeded" }),
    run({ runId: "b1", parentRunId: "it1", nodeId: "body", status: "succeeded" }),
    run({ runId: "it2", parentRunId: "root", nodeId: "loop", iteration: 2, status: "failed" }),
  ];

  it("reuses a succeeded iteration's body, scoped to its container", () => {
    const resume = resolveResume(rootResumeEntry(input(rows)), file);
    const iteration = enterIteration(resume, file, "loop", 1);
    expect(iteration?.counterpart).toBe(rows[1]);
    expect(iteration?.plan.get("body")).toBe(rows[2]);
  });

  it("runs an unsucceeded iteration fresh", () => {
    const resume = resolveResume(rootResumeEntry(input(rows)), file);
    expect(enterIteration(resume, file, "loop", 2)).toBeUndefined();
  });

  it("runs every iteration fresh when the loop is at or after the boundary", () => {
    const resume = resolveResume(
      rootResumeEntry(input(rows, { rerunFromNodePath: ["loop"] })),
      file,
    );
    expect(enterIteration(resume, file, "loop", 1)).toBeUndefined();
  });
});

describe("passResumer — goto pass pairing (ADR 0054 §5–6)", () => {
  const file = tree([binary("a"), binary("b")]);
  const rows = [
    root,
    run({ runId: "p1", parentRunId: "root", nodeId: null, pass: 1, status: "succeeded" }),
    run({ runId: "p1a", parentRunId: "p1", nodeId: "a", status: "succeeded" }),
    run({ runId: "p2", parentRunId: "root", nodeId: "g", pass: 2, status: "succeeded" }),
    run({ runId: "p2a", parentRunId: "p2", nodeId: "a", status: "succeeded" }),
    run({ runId: "p3", parentRunId: "root", nodeId: "g", pass: 3, status: "failed" }),
  ];

  it("pairs each pass with the same ordinal and opener, planning reuse inside it", () => {
    const next = passResumer(resolveResume(rootResumeEntry(input(rows)), file), file);
    expect(next(1, null)).toMatchObject({ counterpart: rows[1] });
    expect(next(2, "g").plan.get("a")).toBe(rows[4]);
    expect(next(3, "g").counterpart).toBe(rows[5]);
  });

  it("stops pairing at the first mismatch, for every later pass", () => {
    const next = passResumer(resolveResume(rootResumeEntry(input(rows)), file), file);
    expect(next(1, null).counterpart).toBe(rows[1]);
    expect(next(2, "other-goto").counterpart).toBeUndefined();
    expect(next(3, "g").counterpart).toBeUndefined();
  });

  it("applies the boundary inside its pass and runs every later pass fresh", () => {
    const next = passResumer(
      resolveResume(
        rootResumeEntry(input(rows, { rerunFromNodePath: ["a"], rerunFromPasses: [2] })),
        file,
      ),
      file,
    );
    expect(next(1, null).plan.get("a")).toBe(rows[2]);
    const atBoundary = next(2, "g");
    expect(atBoundary.counterpart).toBe(rows[3]);
    expect(atBoundary.plan.has("a")).toBe(false);
    expect(atBoundary.rerunPath).toEqual([{ nodeId: "a", pass: 2 }]);
    expect(next(3, "g").counterpart).toBeUndefined();
  });

  it("pairs nothing when the boundary names no pass (a goto added since)", () => {
    const next = passResumer(
      resolveResume(rootResumeEntry(input(rows, { rerunFromNodePath: ["a"] })), file),
      file,
    );
    expect(next(1, null).counterpart).toBeUndefined();
  });
});
