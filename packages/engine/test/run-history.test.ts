import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "@path/schema";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/persistence/db.js";
import { runBlobDir } from "../src/persistence/paths.js";
import { insertReuseRun, insertRun } from "../src/persistence/run-store.js";
import { diskRunHistory } from "../src/run-history.js";

/**
 * The one handle a continuation carries over its predecessor tree: the rows it matches a
 * counterpart against, and the blob addressing that makes a reused row read its source tree. The
 * reuse-row swap (ADR 0001) happens when the handle is built.
 */

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-run-history-test-"));
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

/** The same row as the reader sees it, with the fields the swap reads named explicitly. */
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

describe("diskRunHistory — the reuse-row swap", () => {
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

    const swapped = diskRunHistory(db, dir, [
      record("reuse-1", "root-1", "root-1", { reusedFromRunId: "step-1" }),
    ]).rows;

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
      diskRunHistory(db, dir, [
        record("reuse-1", "root-1", "root-1", { reusedFromRunId: "vanished" }),
      ]).rows,
    ).toEqual([]);
  });

  it("passes an ordinary row through unchanged", () => {
    const ordinary = record("step-1", "root-1");

    expect(diskRunHistory(db, dir, [ordinary]).rows).toEqual([ordinary]);
  });
});

describe("diskRunHistory — the blob reader", () => {
  it("reads out of the tree the record names, which is the source tree for a swapped reuse row", () => {
    const reader = diskRunHistory(db, dir, []).blob;
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
