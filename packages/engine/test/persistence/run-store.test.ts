import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import {
  deleteAllRuns,
  deleteRunsForRoot,
  finishRun,
  getRunsForRoot,
  insertRun,
  setRunBlobRefs,
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
      nodeId: null,
      worker: null,
      status: "running",
    });
    insertRun(db, {
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      worker: { type: "engine" },
      status: "running",
    });

    const rows = getRunsForRoot(db, "root-1");
    expect(rows).toHaveLength(2);
    const child = rows.find((r) => r.runId === "child-1");
    expect(child).toMatchObject({
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      worker: { type: "engine" },
      status: "running",
    });
    expect(child?.startedAt).toBeTruthy();
    expect(child?.finishedAt).toBeNull();
  });

  it("finishRun sets status and finishedAt", () => {
    insertRun(db, { runId: "r1", rootRunId: "r1", parentRunId: null, nodeId: null, worker: null, status: "running" });
    finishRun(db, "r1", "succeeded");

    const [row] = getRunsForRoot(db, "r1");
    expect(row?.status).toBe("succeeded");
    expect(row?.finishedAt).toBeTruthy();
  });

  it("setRunBlobRefs updates input/output refs independently", () => {
    insertRun(db, { runId: "r1", rootRunId: "r1", parentRunId: null, nodeId: null, worker: null, status: "running" });
    setRunBlobRefs(db, "r1", { inputRef: "runs/r1/r1/input.json" });
    setRunBlobRefs(db, "r1", { outputRef: "runs/r1/r1/output.json" });

    const [row] = getRunsForRoot(db, "r1");
    expect(row?.inputRef).toBe("runs/r1/r1/input.json");
    expect(row?.outputRef).toBe("runs/r1/r1/output.json");
  });

  it("setRunUsage records real token counts and the estimated cost on an LLM run row (spec §5.7)", () => {
    insertRun(db, {
      runId: "r1",
      rootRunId: "r1",
      parentRunId: null,
      nodeId: "summarize",
      worker: { type: "llm", model: "claude-sonnet-5" },
      status: "running",
    });
    setRunUsage(db, "r1", { usage: { input_tokens: 12, output_tokens: 34 }, estimatedCostUsd: 0.0053 });

    const [row] = getRunsForRoot(db, "r1");
    expect(row?.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(row?.estimatedCostUsd).toBeCloseTo(0.0053);
  });

  it("leaves usage and cost null on rows where no tokens were spent", () => {
    insertRun(db, { runId: "r1", rootRunId: "r1", parentRunId: null, nodeId: null, worker: null, status: "running" });

    const [row] = getRunsForRoot(db, "r1");
    expect(row?.usage).toBeNull();
    expect(row?.estimatedCostUsd).toBeNull();
  });

  it("scopes getRunsForRoot to only the requested root run's tree", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, worker: null, status: "succeeded" });
    insertRun(db, { runId: "b", rootRunId: "b", parentRunId: null, nodeId: null, worker: null, status: "succeeded" });

    expect(getRunsForRoot(db, "a").map((r) => r.runId)).toEqual(["a"]);
    expect(getRunsForRoot(db, "b").map((r) => r.runId)).toEqual(["b"]);
  });

  it("deleteRunsForRoot removes only that root run's rows", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, worker: null, status: "succeeded" });
    insertRun(db, { runId: "b", rootRunId: "b", parentRunId: null, nodeId: null, worker: null, status: "succeeded" });

    const deleted = deleteRunsForRoot(db, "a");
    expect(deleted).toBe(1);
    expect(getRunsForRoot(db, "a")).toEqual([]);
    expect(getRunsForRoot(db, "b")).toHaveLength(1);
  });

  it("deleteAllRuns wipes every row", () => {
    insertRun(db, { runId: "a", rootRunId: "a", parentRunId: null, nodeId: null, worker: null, status: "succeeded" });
    insertRun(db, { runId: "b", rootRunId: "b", parentRunId: null, nodeId: null, worker: null, status: "succeeded" });

    const deleted = deleteAllRuns(db);
    expect(deleted).toBe(2);
    expect(getRunsForRoot(db, "a")).toEqual([]);
    expect(getRunsForRoot(db, "b")).toEqual([]);
  });
});
