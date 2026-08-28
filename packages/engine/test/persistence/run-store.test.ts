import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import {
  deleteAllRuns,
  deleteRunsForRoot,
  existingRunIds,
  finishRun,
  getRunsForRoot,
  insertRun,
  listRootRuns,
  setRunOutputRef,
  setRunUsage,
} from "../../src/persistence/run-store.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-run-store-test-"));
  db = openDb(join(dir, "path.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("run-store", () => {
  it("inserts a run row and reads it back with correct lineage and status", () => {
    insertRun(db, {
      runId: "root-1",
      rootRunId: "root-1",
      parentRunId: null,
      nodeId: null, nodeName: null,
      workerName: null,
      status: "running",
    });
    insertRun(db, {
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet", nodeName: "greet",
      workerName: "spawn",
      status: "running",
    });

    const rows = getRunsForRoot(db, "root-1");
    expect(rows).toHaveLength(2);
    const child = rows.find((r) => r.runId === "child-1");
    expect(child).toMatchObject({
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet", nodeName: "greet",
      workerName: "spawn",
      status: "running",
    });
    expect(child?.startedAt).toBeTruthy();
    expect(child?.finishedAt).toBeNull();
  });

  it("finishRun sets status and finishedAt", () => {
    insertRun(db, { runId: "r1", rootRunId: "r1", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "running" });
    finishRun(db, "r1", "succeeded");

    const [row] = getRunsForRoot(db, "r1");
    expect(row?.status).toBe("succeeded");
    expect(row?.finishedAt).toBeTruthy();
  });

  // The input ref goes in with the row; only the output ref needs a later UPDATE, because a run's
  // output does not exist until it has succeeded (#72).
  it("insertRun records the input ref with the row, so no row is inserted then immediately updated", () => {
    insertRun(db, {
      runId: "r1",
      rootRunId: "r1",
      parentRunId: null,
      nodeId: null, nodeName: null,
      workerName: null,
      status: "running",
      inputRef: "runs/r1/r1/input.json",
    });

    const [row] = getRunsForRoot(db, "r1");
    expect(row?.inputRef).toBe("runs/r1/r1/input.json");
    expect(row?.outputRef).toBeNull();
  });

  it("insertRun leaves the input ref null when there is none", () => {
    insertRun(db, { runId: "r1", rootRunId: "r1", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "running" });
    expect(getRunsForRoot(db, "r1")[0]?.inputRef).toBeNull();
  });

  // Meaningful only on root rows (#168): set once at a successor root run's insert time to the
  // immediate predecessor's root run id.
  it("insertRun records resumedFromRootRunId on a successor root run and reads it back", () => {
    insertRun(db, { runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });
    insertRun(db, {
      runId: "root-2",
      rootRunId: "root-2",
      parentRunId: null,
      nodeId: null, nodeName: null,
      workerName: null,
      status: "running",
      resumedFromRootRunId: "root-1",
    });

    expect(getRunsForRoot(db, "root-2")[0]?.resumedFromRootRunId).toBe("root-1");
  });

  it("insertRun leaves resumedFromRootRunId null when there is none", () => {
    insertRun(db, { runId: "r1", rootRunId: "r1", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "running" });
    expect(getRunsForRoot(db, "r1")[0]?.resumedFromRootRunId).toBeNull();
  });

  it("setRunOutputRef records the output ref once the run has succeeded", () => {
    insertRun(db, { runId: "r1", rootRunId: "r1", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "running" });
    setRunOutputRef(db, "r1", "runs/r1/r1/output.json");

    expect(getRunsForRoot(db, "r1")[0]?.outputRef).toBe("runs/r1/r1/output.json");
  });

  it("setRunUsage records real token counts and the estimated cost on an LLM run row (spec §5.7)", () => {
    insertRun(db, {
      runId: "r1",
      rootRunId: "r1",
      parentRunId: null,
      nodeId: "summarize", nodeName: "summarize",
      workerName: "sdk",
      status: "running",
    });
    setRunUsage(db, "r1", { usage: { input_tokens: 12, output_tokens: 34 }, estimatedCostUsd: 0.0053 });

    const [row] = getRunsForRoot(db, "r1");
    expect(row?.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(row?.estimatedCostUsd).toBeCloseTo(0.0053);
  });

  it("leaves usage and cost null on rows where no tokens were spent", () => {
    insertRun(db, { runId: "r1", rootRunId: "r1", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "running" });

    const [row] = getRunsForRoot(db, "r1");
    expect(row?.usage).toBeNull();
    expect(row?.estimatedCostUsd).toBeNull();
  });

  it("scopes getRunsForRoot to only the requested root run's tree", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });
    insertRun(db, { runId: "b", rootRunId: "b", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });

    expect(getRunsForRoot(db, "a").map((r) => r.runId)).toEqual(["a"]);
    expect(getRunsForRoot(db, "b").map((r) => r.runId)).toEqual(["b"]);
  });

  it("deleteRunsForRoot removes only that root run's rows", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });
    insertRun(db, { runId: "b", rootRunId: "b", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });

    const deleted = deleteRunsForRoot(db, "a");
    expect(deleted).toBe(1);
    expect(getRunsForRoot(db, "a")).toEqual([]);
    expect(getRunsForRoot(db, "b")).toHaveLength(1);
  });

  it("listRootRuns returns only root runs (run_id = root_run_id), most-recent-first", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });
    // A child of `a` shares its tree but is not itself a root run — must be excluded.
    insertRun(db, {
      runId: "a-child",
      rootRunId: "a",
      parentRunId: "a",
      nodeId: "greet", nodeName: "greet",
      workerName: "spawn",
      status: "succeeded",
    });
    insertRun(db, {
      runId: "b",
      rootRunId: "b",
      parentRunId: null,
      nodeId: null, nodeName: null,
      workerName: null,
      status: "running",
      resumedFromRootRunId: "a",
    });

    const rows = listRootRuns(db);
    expect(rows.map((r) => r.runId)).toEqual(["b", "a"]);
    expect(rows.find((r) => r.runId === "b")?.resumedFromRootRunId).toBe("a");
    expect(rows.find((r) => r.runId === "a")?.resumedFromRootRunId).toBeNull();
  });

  it("listRootRuns caps the result at limit (default 50)", () => {
    for (let i = 0; i < 60; i++) {
      insertRun(db, { runId: `r${i}`, rootRunId: `r${i}`, parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });
    }
    expect(listRootRuns(db)).toHaveLength(50);
    expect(listRootRuns(db, { limit: 3 })).toHaveLength(3);
    // Most-recent-first: the last-inserted rows come back.
    expect(listRootRuns(db, { limit: 3 }).map((r) => r.runId)).toEqual(["r59", "r58", "r57"]);
  });

  it("listRootRuns filters by status", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });
    insertRun(db, { runId: "b", rootRunId: "b", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "failed" });
    insertRun(db, { runId: "c", rootRunId: "c", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });

    expect(listRootRuns(db, { status: "succeeded" }).map((r) => r.runId)).toEqual(["c", "a"]);
    expect(listRootRuns(db, { status: "failed" }).map((r) => r.runId)).toEqual(["b"]);
  });

  it("existingRunIds returns only the ids that still have a row, deduping the input", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });
    insertRun(db, { runId: "b", rootRunId: "b", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });

    expect(existingRunIds(db, ["a", "b", "gone", "a"])).toEqual(new Set(["a", "b"]));
  });

  it("existingRunIds is empty for an empty input, running no query", () => {
    expect(existingRunIds(db, [])).toEqual(new Set());
  });

  it("deleteAllRuns wipes every row", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });
    insertRun(db, { runId: "b", rootRunId: "b", parentRunId: null, nodeId: null, nodeName: null, workerName: null, status: "succeeded" });

    const deleted = deleteAllRuns(db);
    expect(deleted).toBe(2);
    expect(getRunsForRoot(db, "a")).toEqual([]);
    expect(getRunsForRoot(db, "b")).toEqual([]);
  });
});
