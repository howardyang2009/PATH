import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FORMAT_VERSION,
  type GotoNode,
  type JsonValue,
  type LaunchFacts,
  type RunRecord,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResumeEntry } from "../src/continuation.js";
import {
  completeContinuation,
  continuationBlobReader,
  continuationRunOptions,
  noContinuation,
  passFirstNode,
  recordedPasses,
  resumeContinuation,
  rootResumeEntry,
  sourceRuns,
  successorCapture,
} from "../src/continuation.js";
import { openDb } from "../src/persistence/db.js";
import { runBlobDir } from "../src/persistence/paths.js";
import { insertReuseRun, insertRun } from "../src/persistence/run-store.js";
import type { ContinueState } from "../src/run-context.js";
import type { RunEvent } from "../src/run-observer.js";

/**
 * The continuation recipe Resume and Complete share (#architecture-deepening). These pin the four
 * answers `continuation.ts` owns — the reuse-row swap, the blob reader, the recovered launch facts,
 * and the successor-root capture — because both engine entry points read them and neither may
 * drift.
 */

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-continuation-test-"));
  db = openDb(join(dir, "path.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A row to insert: only the fields these tests care about, the rest left at their column
 * defaults. */
function newRow(runId: string, parentRunId: string | null, rootRunId = "root-1") {
  return {
    runId,
    rootRunId,
    parentRunId,
    nodeId: `node-${runId}`,
    nodeName: runId,
    workerName: null,
    status: "running" as const,
  };
}

/** The same row as the reader sees it, with the fields `sourceRuns` reads named explicitly. */
function record(
  runId: string,
  parentRunId: string | null,
  rootRunId = "root-1",
  extra: Partial<RunRecord> = {},
): RunRecord {
  return {
    ...newRow(runId, parentRunId, rootRunId),
    iteration: null,
    pass: null,
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    reusedFromRunId: null,
    ...extra,
  } as unknown as RunRecord;
}

describe("sourceRuns", () => {
  it("swaps a reuse row for its source record, keeping the reuse row's own parent", () => {
    insertRun(db, newRow("root-1", null));
    insertRun(db, { ...newRow("step-1", "root-1"), status: "succeeded" });
    insertReuseRun(db, {
      runId: "reuse-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "node-step-1",
      nodeName: "step-1",
      reusedFromRunId: "step-1",
    });

    const swapped = sourceRuns(db, [
      record("reuse-1", "root-1", "root-1", { reusedFromRunId: "step-1" }),
    ]);

    // The reuse row keeps the parent it sat under, but names the source's run and tree from now on.
    expect(swapped[0]).toMatchObject({
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      status: "succeeded",
    });
  });

  it("drops a reuse row whose source is gone, so that node re-executes", () => {
    expect(
      sourceRuns(db, [record("reuse-1", "root-1", "root-1", { reusedFromRunId: "vanished" })]),
    ).toEqual([]);
  });

  it("passes an ordinary row through unchanged", () => {
    const ordinary = record("step-1", "root-1");

    expect(sourceRuns(db, [ordinary])).toEqual([ordinary]);
  });
});

describe("continuationBlobReader", () => {
  it("reads out of the tree the record names, which is the source tree for a swapped reuse row", () => {
    const reader = continuationBlobReader(dir);
    for (const [rootRunId, value] of [
      ["source-root", { from: "source" }],
      ["other-root", { from: "other" }],
    ] as const) {
      const blobDir = runBlobDir(dir, rootRunId, "step-1");
      mkdirSync(blobDir, { recursive: true });
      writeFileSync(join(blobDir, "output.json"), JSON.stringify(value));
    }

    expect(reader(record("step-1", "parent-1", "source-root"), "output.json")).toEqual({
      from: "source",
    });
    expect(reader(record("step-1", "parent-1", "other-root"), "output.json")).toEqual({
      from: "other",
    });
  });
});

describe("continuationRunOptions", () => {
  const frozen: LaunchFacts = {
    config: { model: "frozen-model", token: "[secret:token]" },
    workerDefaults: { prompt: "sdk" },
    secretKeys: ["token"],
  };

  it("recovers the frozen config and the launch worker-default table when the caller supplies nothing", () => {
    const options = continuationRunOptions({ rerunFromRunId: "run-7" }, frozen);

    expect(options.operatorConfig).toEqual({ model: "frozen-model", token: "[secret:token]" });
    expect(options.launchWorkerDefaults).toEqual({ prompt: "sdk" });
    expect(options.inheritedLaunchSecretKeys).toEqual(["token"]);
    // The frozen input is shown to a reader, never replayed: a continuation restores the context.
    expect(options.operatorInput).toBeUndefined();
  });

  it("consumes the rerun boundary, which is a Resume's business and never a run option", () => {
    expect(continuationRunOptions({ rerunFromRunId: "run-7" }, undefined)).not.toHaveProperty(
      "rerunFromRunId",
    );
  });

  it("merges a supplied value over the frozen one and re-marks a supplied secret at its recorded path", () => {
    const options = continuationRunOptions(
      { operatorConfig: { model: "supplied-model", token: "real-credential" } },
      frozen,
    );

    expect(options.operatorConfig).toEqual({
      model: "supplied-model",
      token: { $secret: "real-credential" },
    });
    // Supplied again, so nothing is missing — the run must not end at its first step naming the
    // key.
    expect(options.unresolvedLaunchSecrets).toEqual([]);
  });

  it("reports a frozen secret the caller did not supply again", () => {
    const options = continuationRunOptions({ operatorConfig: { model: "only-a-model" } }, frozen);

    expect(options.unresolvedLaunchSecrets).toEqual(["token"]);
  });
});

describe("successorCapture", () => {
  const started = (runId: string, parentRunId: string | null): RunEvent => ({
    runId,
    rootRunId: parentRunId === null ? runId : "root-2",
    event: {
      type: "step-started",
      ts: "2026-01-01T00:00:00.000Z",
      run_id: runId,
      node_id: null,
      node_name: null,
      step_type: "workflow",
      worker_name: "workflow",
    },
    payload: { kind: "started", parentRunId, input: {} },
  });

  it("captures the successor's own root run, ignoring a nested run's start", () => {
    const capture = successorCapture();

    capture.observer.observe(started("nested-1", "root-2"));
    capture.observer.observe(started("root-2", null));

    expect(capture.rootRunId()).toBe("root-2");
  });

  it("throws rather than returning an id it never saw", () => {
    expect(() => successorCapture().rootRunId()).toThrow(/emitted no root start/);
  });
});

/** A node the disposition adapters read: only the two fields they look at, cast to the body-node
 * type. */
function node(id: string, type = "binary"): WorkflowFile["body"][number] {
  return { id, type } as unknown as WorkflowFile["body"][number];
}

/** A file holding exactly the nodes a plan can reuse. */
const file: WorkflowFile = {
  format: FORMAT_VERSION,
  id: "11111111-1111-4111-8111-111111111111",
  name: "t",
  body: [
    node("a"),
    {
      type: "workflow",
      id: "nested",
      name: "nested",
      ref: "child.json",
      input: {},
    } as unknown as WorkflowFile["body"][number],
  ],
};

/** A Complete-continue state over a fixed row set, targeting one parked leaf by id. */
function continueState(existingRuns: RunRecord[], targetStepRunId: string): ContinueState {
  return {
    existingRuns,
    readBlob: (run) => ({ from: run.runId }),
    target: { stepRunId: targetStepRunId, output: { submitted: true } },
  };
}

describe("resumeContinuation — Resume adapter", () => {
  const counterpart = record("orig-root", null, "root-1", { nodeId: null, status: "failed" });
  const original = record("orig-1", "orig-root", "root-1", { nodeId: "a", status: "succeeded" });
  const readBlob = (run: RunRecord, filename: string) => ({ from: run.runId, file: filename });
  const entry: ResumeEntry = {
    input: { originalRuns: [counterpart, original], readBlob },
    counterpart,
    rerunPath: [],
  };

  it("reuses a node the plan holds, and runs every other node fresh", () => {
    const c = resumeContinuation(entry, file, false);

    const reused = c.disposition(node("a"));
    expect(reused).toMatchObject({ kind: "reuse", reusedFrom: "orig-1" });
    // The output is read from the original tree's run, only when the walker asks for it.
    expect(reused.kind === "reuse" && reused.output()).toEqual({
      from: "orig-1",
      file: "output.json",
    });
    expect(c.disposition(node("b"))).toEqual({ kind: "run" });
  });

  it("runs every node for a plain forward run (no continuation)", () => {
    expect(noContinuation().disposition(node("a"))).toEqual({ kind: "run" });
    expect(noContinuation().start()).toBeUndefined();
  });

  it("seeds a re-entered root run from its counterpart's input, never a nested one", () => {
    const reads: string[] = [];
    const seeded: ResumeEntry = {
      ...entry,
      input: {
        originalRuns: [counterpart, original],
        readBlob: (run, filename) => {
          reads.push(`${run.runId}/${filename}`);
          return { blob: filename };
        },
      },
    };

    expect(resumeContinuation(seeded, file, true).start()).toEqual({
      kind: "seed",
      seed: { blob: "input.json" },
    });
    expect(reads).toEqual(["orig-root/input.json"]);
    // A nested run starts from its own interpolated input, not the counterpart's.
    expect(resumeContinuation(seeded, file, false).start()).toEqual({
      kind: "seed",
      seed: undefined,
    });
  });
});

describe("completeContinuation — Complete adapter", () => {
  const complete = (rows: RunRecord[], target: string) =>
    completeContinuation(continueState(rows, target), file, "parent-1");

  it("reuses a succeeded row read-only", () => {
    const existing = record("r1", "parent-1", "root-1", {
      nodeId: "a",
      status: "succeeded",
      outputRef: "output.json",
    });
    const reused = complete([existing], "none").disposition(node("a"));
    // Read-only from this tree's own row, and unmarked: a Complete is not a fresh successor tree.
    expect(reused).toMatchObject({ kind: "reuse" });
    expect(reused.kind === "reuse" && reused.reusedFrom).toBeUndefined();
    expect(reused.kind === "reuse" && reused.output()).toEqual({ from: "r1" });
  });

  it("completes the parked target leaf, but parks another parked sibling", () => {
    const target = record("r-target", "parent-1", "root-1", { nodeId: "a", status: "awaiting" });
    const sibling = record("r-sib", "parent-1", "root-1", { nodeId: "b", status: "awaiting" });
    const c = complete([target, sibling], "r-target");

    expect(c.disposition(node("a"))).toEqual({
      kind: "settle",
      runId: "r-target",
      output: { submitted: true },
    });
    expect(c.disposition(node("b"))).toEqual({ kind: "park" });
  });

  it("re-enters a non-terminal workflow-run row, but runs a non-terminal leaf fresh", () => {
    const wfRow = record("r-wf", "parent-1", "root-1", { nodeId: "nested", status: "running" });
    const leafRow = record("r-leaf", "parent-1", "root-1", { nodeId: "b", status: "running" });
    const c = complete([wfRow, leafRow], "none");

    expect(c.disposition(node("nested", "workflow"))).toEqual({ kind: "run", existing: wfRow });
    expect(c.disposition(node("b", "binary"))).toEqual({ kind: "run" });
  });

  it("runs fresh when no row under this parent answers the node", () => {
    const elsewhere = record("r1", "other-parent", "root-1", { nodeId: "a", status: "succeeded" });
    expect(complete([elsewhere], "none").disposition(node("a"))).toEqual({ kind: "run" });
  });

  it("restores a re-entered run's parked blackboard, and nothing for a fresh one", () => {
    const own = record("r-wf", "parent-1", "root-1", {
      nodeId: "nested",
      status: "running",
    });
    const c = completeContinuation(continueState([own], "none"), file, "r-wf");

    expect(c.start()).toEqual({ kind: "reentry", existing: own, context: { from: "r-wf" } });
    expect(complete([], "none").start()).toBeUndefined();
  });

  it("scopes a nested run's pass walk to the child file, not the parent's", () => {
    const goto = {
      type: "goto",
      id: "check",
      name: "check",
      target: "review",
      max_jumps: 3,
    } as unknown as WorkflowFile["body"][number];
    const childFile: WorkflowFile = {
      format: FORMAT_VERSION,
      id: "22222222-2222-4222-8222-222222222222",
      name: "child",
      body: [
        node("intake"),
        {
          type: "sequence",
          id: "review",
          name: "review",
          body: [node("draft")],
        } as unknown as WorkflowFile["body"][number],
        goto,
      ],
    };
    const rows = [
      record("p2", "child-run", "root-1", { nodeId: "check", pass: 2, status: "running" }),
      record("p2-draft", "p2", "root-1", { nodeId: "draft", status: "succeeded" }),
    ];
    const parent = completeContinuation(continueState(rows, "none"), file, "parent-1");
    const identity = {
      runId: "child-run",
      rootRunId: "root-1",
      parentRunId: "parent-1",
      nodeId: "nested",
      nodeName: "nested",
    };

    const walk = parent
      .enter({ owner: null }, childFile, identity)
      .passWalk(new Map([["check", goto as GotoNode]]), {});

    // Pass 2 starts at the child's own `review` sequence, matching the row it recorded first.
    if ("diverged" in walk) throw new Error(walk.error);
    expect(walk).toMatchObject({ pass: 2, opener: goto, start: 1 });
  });
});

// The pass-walk fixtures: a file with a goto, and rows that name the pass each was recorded under.
const gotoCheck: GotoNode = {
  type: "goto",
  id: "check",
  name: "check",
  target: "review",
  max_jumps: 3,
};
const reviewSequence: WorkflowFile["body"][number] = {
  type: "sequence",
  id: "review",
  name: "review",
  body: [node("draft"), node("lint")],
};
const gotoFile: WorkflowFile = {
  format: FORMAT_VERSION,
  id: "11111111-1111-4111-8111-111111111111",
  name: "t",
  body: [node("intake"), reviewSequence, gotoCheck],
};
const gotoMap = new Map([["check", gotoCheck]]);

/** A Complete state whose every blob is named after its own run, so a re-entry's carried input is
 * visible in the walk. */
function passContinueState(existingRuns: RunRecord[]): ContinueState {
  return {
    existingRuns,
    readBlob: (run, filename) => ({ blob: `${run.runId}/${filename}` }) as JsonValue,
    target: { stepRunId: "leaf", output: {} },
  };
}

describe("passFirstNode", () => {
  it("looks through a sequence target to its first recorded node (ADR 0064)", () => {
    expect(passFirstNode(reviewSequence)?.id).toBe("draft");
    expect(passFirstNode(node("intake"))?.id).toBe("intake");
  });
});

describe("the pass walk's start", () => {
  it("starts a launch at pass 1 from the top, with no jumps spent", () => {
    const walk = noContinuation().passWalk(gotoMap, { seed: 1 });
    expect(walk).toMatchObject({
      pass: 1,
      opener: null,
      start: 0,
      carried: { seed: 1 },
      reentered: undefined,
    });
    if ("diverged" in walk) throw new Error("unexpected divergence");
    expect(walk.jumpsSpent.size).toBe(0);
  });

  it("re-enters a Complete's running pass at its goto's target, counting every recorded pass as a jump", () => {
    const rows = [
      record("p1", "root", "root", { nodeId: null, nodeName: null, pass: 1, status: "succeeded" }),
      record("p2", "root", "root", {
        nodeId: "check",
        nodeName: "check",
        pass: 2,
        status: "succeeded",
      }),
      record("p3", "root", "root", {
        nodeId: "check",
        nodeName: "check",
        pass: 3,
        status: "running",
      }),
      record("p3-draft", "p3", "root", { nodeId: "draft", nodeName: "draft", status: "succeeded" }),
    ];
    const walk = completeContinuation(passContinueState(rows), gotoFile, "root").passWalk(
      gotoMap,
      {},
    );
    if ("diverged" in walk) throw new Error(walk.error);
    expect(walk).toMatchObject({
      pass: 3,
      opener: gotoCheck,
      start: 1,
      carried: { blob: "p3/input.json" },
      reentered: rows[2],
    });
    expect(walk.jumpsSpent.get("check")).toBe(2);
  });

  it("fails a Complete whose running pass no longer opens at the node it recorded first", () => {
    const rows = [
      record("p1", "root", "root", { nodeId: null, nodeName: null, pass: 1, status: "succeeded" }),
      record("p2", "root", "root", {
        nodeId: "check",
        nodeName: "check",
        pass: 2,
        status: "running",
      }),
      record("p2-intake", "p2", "root", {
        nodeId: "intake",
        nodeName: "intake",
        status: "succeeded",
      }),
    ];
    const walk = completeContinuation(passContinueState(rows), gotoFile, "root").passWalk(
      gotoMap,
      {},
    );
    expect(walk).toMatchObject({ diverged: rows[1] });
    expect("error" in walk && walk.error).toContain('recorded "intake"');
  });
});

describe("recordedPasses", () => {
  it("lists one run's pass rows in ordinal order", () => {
    const rows = [
      record("p2", "root", "root", { nodeId: "check", pass: 2, status: "succeeded" }),
      record("x", "root", "root", { nodeId: "intake", status: "succeeded" }),
      record("p1", "root", "root", { nodeId: null, pass: 1, status: "succeeded" }),
    ];
    expect(recordedPasses(rows, "root").map((r) => r.runId)).toEqual(["p1", "p2"]);
  });
});

/** A predecessor tree of in-memory rows and a blob reader; no store. */
function resumeInput(
  originalRuns: RunRecord[],
  extra: Partial<Parameters<typeof rootResumeEntry>[0]> = {},
) {
  return rootResumeEntry({
    originalRuns,
    readBlob: (r, filename) => ({ blob: `${r.runId}/${filename}` }) as JsonValue,
    ...extra,
  });
}

/** A one-step file with the given id. */
function binaryFile(id: string): WorkflowFile {
  return {
    format: FORMAT_VERSION,
    id: "22222222-2222-4222-8222-222222222222",
    name: "t",
    body: [node(id)],
  };
}

describe("the Resume plan through the Continuation seam", () => {
  const predecessorRoot = record("orig-root", null, "root-1", { nodeId: null, status: "failed" });

  it("plans plain Resume reuse of every succeeded top-level child, and re-runs the rest", () => {
    const file = binaryFile("a");
    file.body = [node("a"), node("b"), node("c")];
    const runs = [
      predecessorRoot,
      record("ra", "orig-root", "root-1", { nodeId: "a", status: "succeeded" }),
      record("rb", "orig-root", "root-1", { nodeId: "b", status: "succeeded" }),
      record("rc", "orig-root", "root-1", { nodeId: "c", status: "failed" }),
    ];
    const c = resumeContinuation(resumeInput(runs), file, true);

    expect(c.disposition(node("a"))).toMatchObject({ kind: "reuse", reusedFrom: "ra" });
    expect(c.disposition(node("b"))).toMatchObject({ kind: "reuse", reusedFrom: "rb" });
    // A predecessor row that did not succeed is re-run, not reused.
    expect(c.disposition(node("c"))).toEqual({ kind: "run" });
  });

  it("suppresses the boundary node and everything serialized after it", () => {
    const file = binaryFile("a");
    file.body = [node("a"), node("b"), node("c")];
    const runs = [
      predecessorRoot,
      record("ra", "orig-root", "root-1", { nodeId: "a", status: "succeeded" }),
      record("rb", "orig-root", "root-1", { nodeId: "b", status: "succeeded" }),
      record("rc", "orig-root", "root-1", { nodeId: "c", status: "succeeded" }),
    ];
    const c = resumeContinuation(resumeInput(runs, { rerunFromNodePath: ["b"] }), file, true);

    expect(c.disposition(node("a"))).toMatchObject({ kind: "reuse" });
    expect(c.disposition(node("b"))).toEqual({ kind: "run" });
    expect(c.disposition(node("c"))).toEqual({ kind: "run" });
  });

  it("seeds only a root run from its counterpart's recorded input (ADR 0062)", () => {
    const runs = [predecessorRoot];
    const reads: string[] = [];
    const entry: ResumeEntry = rootResumeEntry({
      originalRuns: runs,
      readBlob: (run, filename) => {
        reads.push(`${run.runId}/${filename}`);
        return { blob: filename };
      },
    });

    expect(resumeContinuation(entry, binaryFile("a"), true).start()).toEqual({
      kind: "seed",
      seed: { blob: "input.json" },
    });
    expect(reads).toEqual(["orig-root/input.json"]);
    // A nested run starts from its own interpolated input, not the counterpart's.
    expect(resumeContinuation(entry, binaryFile("a"), false).start()).toEqual({
      kind: "seed",
      seed: undefined,
    });
  });
});

describe("enter — one operation per scope kind", () => {
  const predecessorRoot = record("orig-root", null, "root-1", { nodeId: null, status: "failed" });
  const identity = {
    runId: "succ",
    rootRunId: "succ",
    parentRunId: "orig-root",
    nodeId: null,
    nodeName: null,
  };

  function nestedFile(): WorkflowFile {
    const f = binaryFile("w");
    f.body = [
      { type: "workflow", id: "w", name: "w", ref: "child.json", input: {} },
      { type: "workflow", id: "x", name: "x", ref: "child.json", input: {} },
    ] as unknown as WorkflowFile["body"];
    return f;
  }

  it("descends the path-node with the path's tail, and re-runs a node after the boundary entire", () => {
    const file = nestedFile();
    const runs = [
      predecessorRoot,
      record("rw", "orig-root", "root-1", { nodeId: "w", status: "failed" }),
      record("rx", "orig-root", "root-1", { nodeId: "x", status: "succeeded" }),
    ];
    const entry = resumeInput(runs, {
      rerunFromNodePath: ["w", "inner"],
      rerunFromPasses: [null, 3],
    });
    const c = resumeContinuation(entry, file, false);

    // `w` is the boundary's path-node: its counterpart is the one under this node, and the tail of
    // the path rides into it.
    const descended = c.enter({ owner: { id: "w", name: "w" } }, binaryFile("inner"), identity);
    expect(descended.disposition(node("inner"))).toEqual({ kind: "run" });
    // `x` is serialized after the boundary, so it re-runs entire.
    const after = c.enter({ owner: { id: "x", name: "x" } }, binaryFile("inner"), identity);
    expect(after.disposition(node("inner"))).toEqual({ kind: "run" });
  });

  it("reuses a succeeded while-do iteration's body, scoped to its container", () => {
    const loop = {
      type: "while-do",
      id: "loop",
      name: "loop",
      condition: { type: "exists", path: "context.more" },
      max_iterations: 3,
      node: node("body"),
    } as unknown as WorkflowNode;
    const file = binaryFile("loop");
    file.body = [loop, node("after")];
    const runs = [
      predecessorRoot,
      record("it1", "orig-root", "root-1", { nodeId: "loop", iteration: 1, status: "succeeded" }),
      record("b1", "it1", "root-1", { nodeId: "body", status: "succeeded" }),
      record("it2", "orig-root", "root-1", { nodeId: "loop", iteration: 2, status: "failed" }),
    ];
    const c = resumeContinuation(resumeInput(runs), file, false);

    const first = c.enter(
      { owner: { id: "loop", name: "loop" }, iteration: 1 },
      binaryFile("body"),
      identity,
    );
    expect(first.disposition(node("body"))).toMatchObject({ kind: "reuse", reusedFrom: "b1" });
    // An unsucceeded iteration container is entered fresh.
    const second = c.enter(
      { owner: { id: "loop", name: "loop" }, iteration: 2 },
      binaryFile("body"),
      identity,
    );
    expect(second.disposition(node("body"))).toEqual({ kind: "run" });
  });

  it("runs every iteration fresh when the loop is the boundary", () => {
    const loop = {
      type: "while-do",
      id: "loop",
      name: "loop",
      condition: { type: "exists", path: "context.more" },
      max_iterations: 3,
      node: node("body"),
    } as unknown as WorkflowNode;
    const file = binaryFile("loop");
    file.body = [loop];
    const runs = [
      predecessorRoot,
      record("it1", "orig-root", "root-1", { nodeId: "loop", iteration: 1, status: "succeeded" }),
      record("b1", "it1", "root-1", { nodeId: "body", status: "succeeded" }),
    ];
    const c = resumeContinuation(resumeInput(runs, { rerunFromNodePath: ["loop"] }), file, false);

    const first = c.enter(
      { owner: { id: "loop", name: "loop" }, iteration: 1 },
      binaryFile("body"),
      identity,
    );
    expect(first.disposition(node("body"))).toEqual({ kind: "run" });
  });

  it("pairs each goto pass with the same ordinal and opener, planning reuse inside it", () => {
    const file = binaryFile("a");
    file.body = [
      { type: "goto", id: "g", name: "g", target: "a", max_jumps: 3 } as unknown as WorkflowNode,
      node("a"),
    ];
    const runs = [
      predecessorRoot,
      record("p1", "orig-root", "root-1", { nodeId: null, pass: 1, status: "succeeded" }),
      record("p1a", "p1", "root-1", { nodeId: "a", status: "succeeded" }),
      record("p2", "orig-root", "root-1", { nodeId: "g", pass: 2, status: "succeeded" }),
      record("p2a", "p2", "root-1", { nodeId: "a", status: "succeeded" }),
      record("p3", "orig-root", "root-1", { nodeId: "g", pass: 3, status: "failed" }),
    ];
    const c = resumeContinuation(resumeInput(runs), file, false);
    const opener = { id: "g", name: "g" };

    expect(c.enter({ owner: null, pass: 1 }, file, identity).disposition(node("a"))).toMatchObject({
      kind: "reuse",
      reusedFrom: "p1a",
    });
    expect(
      c.enter({ owner: opener, pass: 2 }, file, identity).disposition(node("a")),
    ).toMatchObject({
      kind: "reuse",
      reusedFrom: "p2a",
    });
    expect(c.enter({ owner: opener, pass: 3 }, file, identity).disposition(node("a"))).toEqual({
      kind: "run",
    });
  });

  it("stops pairing at the first opener mismatch, for every later pass", () => {
    const file = binaryFile("a");
    file.body = [
      { type: "goto", id: "g", name: "g", target: "a", max_jumps: 3 } as unknown as WorkflowNode,
      node("a"),
    ];
    const runs = [
      predecessorRoot,
      record("p1", "orig-root", "root-1", { nodeId: null, pass: 1, status: "succeeded" }),
      record("p1a", "p1", "root-1", { nodeId: "a", status: "succeeded" }),
      record("p2", "orig-root", "root-1", { nodeId: "g", pass: 2, status: "succeeded" }),
      record("p2a", "p2", "root-1", { nodeId: "a", status: "succeeded" }),
      record("p3", "orig-root", "root-1", { nodeId: "g", pass: 3, status: "succeeded" }),
    ];
    const c = resumeContinuation(resumeInput(runs), file, false);

    expect(c.enter({ owner: null, pass: 1 }, file, identity).disposition(node("a"))).toMatchObject({
      kind: "reuse",
    });
    // Pass 2 names an opener the record does not hold, so it and pass 3 run fresh.
    expect(
      c
        .enter({ owner: { id: "other", name: "other" }, pass: 2 }, file, identity)
        .disposition(node("a")),
    ).toEqual({ kind: "run" });
    expect(
      c.enter({ owner: { id: "g", name: "g" }, pass: 3 }, file, identity).disposition(node("a")),
    ).toEqual({ kind: "run" });
  });

  it("applies the boundary inside its pass, and runs every later pass fresh", () => {
    const file = binaryFile("a");
    file.body = [
      { type: "goto", id: "g", name: "g", target: "a", max_jumps: 3 } as unknown as WorkflowNode,
      node("a"),
    ];
    const runs = [
      predecessorRoot,
      record("p1", "orig-root", "root-1", { nodeId: null, pass: 1, status: "succeeded" }),
      record("p1a", "p1", "root-1", { nodeId: "a", status: "succeeded" }),
      record("p2", "orig-root", "root-1", { nodeId: "g", pass: 2, status: "succeeded" }),
      record("p2a", "p2", "root-1", { nodeId: "a", status: "succeeded" }),
      record("p3", "orig-root", "root-1", { nodeId: "g", pass: 3, status: "succeeded" }),
      record("p3a", "p3", "root-1", { nodeId: "a", status: "succeeded" }),
    ];
    const c = resumeContinuation(
      resumeInput(runs, { rerunFromNodePath: ["a"], rerunFromPasses: [2] }),
      file,
      false,
    );

    // Pass 1 is before the boundary pass, so it pairs and reuses.
    expect(c.enter({ owner: null, pass: 1 }, file, identity).disposition(node("a"))).toMatchObject({
      kind: "reuse",
      reusedFrom: "p1a",
    });
    // Pass 2 holds the boundary node, so `a` re-runs there and every later pass runs fresh.
    expect(
      c.enter({ owner: { id: "g", name: "g" }, pass: 2 }, file, identity).disposition(node("a")),
    ).toEqual({ kind: "run" });
    expect(
      c.enter({ owner: { id: "g", name: "g" }, pass: 3 }, file, identity).disposition(node("a")),
    ).toEqual({ kind: "run" });
  });
});
