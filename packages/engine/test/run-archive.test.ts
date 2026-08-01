import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, LogEvent } from "@path/schema";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbLogBackend } from "../src/logging/db-backend.js";
import { LOG_FORMAT } from "../src/logging/log-backend.js";
import { writeRunBlob } from "../src/persistence/blob-store.js";
import { openDb } from "../src/persistence/db.js";
import { dbFilePath, rootRunTreeDir, runsDir } from "../src/persistence/paths.js";
import { finishRun, insertRun, setRunOutputRef } from "../src/persistence/run-store.js";
import { createRunArchive, openRunArchive, type RunArchive } from "../src/run-archive.js";

let dir: string;
let db: Database.Database;
let archive: RunArchive;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-run-archive-test-"));
  db = openDb(dbFilePath(dir));
  archive = createRunArchive(db, dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A root run row plus one child, as the persisted observer would have written them. */
function seedTree(rootRunId = "root-1"): void {
  insertRun(db, {
    runId: rootRunId,
    rootRunId,
    parentRunId: null,
    nodeId: null,
    worker: { type: "engine" },
    status: "running",
  });
  insertRun(db, {
    runId: `${rootRunId}-child`,
    rootRunId,
    parentRunId: rootRunId,
    nodeId: "greet",
    worker: { type: "engine" },
    status: "running",
  });
}

function succeedRootWithOutput(rootRunId: string, output: JsonValue): void {
  const ref = writeRunBlob(dir, rootRunId, rootRunId, "output.json", output);
  setRunOutputRef(db, rootRunId, ref);
  finishRun(db, rootRunId, "succeeded");
}

function stepStarted(seq: number, runId: string): LogEvent {
  return {
    type: "step-started",
    seq,
    ts: new Date().toISOString(),
    run_id: runId,
    node_id: "greet",
    step_type: "binary",
    worker: { type: "engine" },
  };
}

function writeNdjsonLog(rootRunId: string, events: LogEvent[]): void {
  const treeDir = rootRunTreeDir(dir, rootRunId);
  mkdirSync(treeDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "log-header", format: "path/log@0", run_id: rootRunId }),
    ...events.map((event) => JSON.stringify(event)),
  ];
  writeFileSync(join(treeDir, "run.log"), `${lines.join("\n")}\n`, "utf8");
}

/** The same events through the db backend — a run whose `log_backends` did not include `ndjson`. */
async function writeDbLog(rootRunId: string, events: LogEvent[]): Promise<void> {
  const backend = createDbLogBackend(db);
  await backend.open({ runId: rootRunId, format: LOG_FORMAT });
  for (const event of events) await backend.write(event);
  await backend.close();
}

describe("run archive — tree", () => {
  it("returns null for an id no rows exist for, which is every read path's 404", () => {
    expect(archive.tree("never-ran")).toBeNull();
  });

  it("returns the whole tree and names the root row", () => {
    seedTree();

    const tree = archive.tree("root-1")!;
    expect(tree.rootRunId).toBe("root-1");
    expect(tree.runs.map((run) => run.runId)).toEqual(["root-1", "root-1-child"]);
    expect(tree.root?.runId).toBe("root-1");
    expect(tree.has("root-1-child")).toBe(true);
    expect(tree.has("some-other-run")).toBe(false);
  });

  it("reports a null root when the tree has rows but not the root's own", () => {
    insertRun(db, {
      runId: "child-only",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      worker: { type: "engine" },
      status: "succeeded",
    });

    const tree = archive.tree("root-1")!;
    expect(tree.runs).toHaveLength(1);
    expect(tree.root).toBeNull();
  });
});

describe("run archive — blobs", () => {
  it("reads a run's blob without the caller knowing the filename or the directory", () => {
    seedTree();
    writeRunBlob(dir, "root-1", "root-1-child", "input.json", { name: "world" });

    expect(archive.tree("root-1")!.blob("root-1-child", "input")).toEqual({ name: "world" });
  });

  it("is undefined for a run outside the tree and for a blob that was never written", () => {
    seedTree();

    const tree = archive.tree("root-1")!;
    expect(tree.blob("not-in-this-tree", "input")).toBeUndefined();
    expect(tree.blob("root-1-child", "output")).toBeUndefined();
  });

  it("distinguishes a stored null from a missing blob", () => {
    seedTree();
    writeRunBlob(dir, "root-1", "root-1-child", "output.json", null);

    expect(archive.tree("root-1")!.blob("root-1-child", "output")).toBeNull();
  });

  it("serves the root run's output only once it has succeeded with a recorded ref", () => {
    seedTree();
    writeRunBlob(dir, "root-1", "root-1", "output.json", { greeting: "hi" });

    // The blob is on disk, but the row doesn't record it yet — the row is what says a run has an
    // output, so the archive reports none.
    expect(archive.tree("root-1")!.output()).toBeUndefined();

    succeedRootWithOutput("root-1", { greeting: "hi" });
    expect(archive.tree("root-1")!.output()).toEqual({ greeting: "hi" });
  });

  it("has no output for a failed root, whatever is on disk", () => {
    seedTree();
    writeRunBlob(dir, "root-1", "root-1", "output.json", { partial: true });
    finishRun(db, "root-1", "failed");

    expect(archive.tree("root-1")!.output()).toBeUndefined();
  });
});

describe("run archive — events", () => {
  it("reads the persisted narrative in seq order, skipping the header line", () => {
    seedTree();
    writeNdjsonLog("root-1", [stepStarted(1, "root-1"), stepStarted(2, "root-1-child")]);

    expect(archive.tree("root-1")!.events().map((event) => event.seq)).toEqual([1, 2]);
  });

  it("slices the replay to what a reconnecting client hasn't seen", () => {
    seedTree();
    writeNdjsonLog("root-1", [stepStarted(1, "root-1"), stepStarted(2, "root-1-child"), stepStarted(3, "root-1")]);

    expect(archive.tree("root-1")!.events(1).map((event) => event.seq)).toEqual([2, 3]);
    expect(archive.tree("root-1")!.events(9)).toEqual([]);
  });

  it("replays out of log_events for a run whose ndjson backend was off", async () => {
    seedTree();
    await writeDbLog("root-1", [stepStarted(1, "root-1"), stepStarted(2, "root-1-child")]);

    expect(archive.tree("root-1")!.events().map((event) => event.seq)).toEqual([1, 2]);
  });

  it("slices a db replay the same way it slices an ndjson one", async () => {
    seedTree();
    await writeDbLog("root-1", [stepStarted(1, "root-1"), stepStarted(2, "root-1-child"), stepStarted(3, "root-1")]);

    expect(archive.tree("root-1")!.events(1).map((event) => event.seq)).toEqual([2, 3]);
    expect(archive.tree("root-1")!.events(9)).toEqual([]);
  });

  it("prefers run.log when both backends recorded the run", async () => {
    seedTree();
    writeNdjsonLog("root-1", [stepStarted(1, "root-1")]);
    // Deliberately divergent — only the source that won shows up. In production the two agree; what
    // is pinned here is which one is read, so the default configuration keeps reading the file.
    await writeDbLog("root-1", [stepStarted(1, "root-1"), stepStarted(2, "root-1-child")]);

    expect(archive.tree("root-1")!.events().map((event) => event.seq)).toEqual([1]);
  });

  it("falls back to log_events when run.log holds only its header", async () => {
    seedTree();
    writeNdjsonLog("root-1", []);
    await writeDbLog("root-1", [stepStarted(1, "root-1")]);

    // An existing-but-empty file is not a narrative, so an in-flight run whose first event has not
    // reached disk still replays rather than reporting nothing.
    expect(archive.tree("root-1")!.events().map((event) => event.seq)).toEqual([1]);
  });

  it("is empty for a run no log backend recorded", () => {
    seedTree();

    expect(archive.tree("root-1")!.events()).toEqual([]);
  });

  it("passes db events through untouched — they were masked before the write seam", async () => {
    seedTree();
    const masked: LogEvent = {
      type: "step-finished",
      seq: 1,
      ts: new Date().toISOString(),
      run_id: "root-1",
      node_id: "greet",
      status: "failed",
      error: "exit 1: token=***",
    };
    await writeDbLog("root-1", [masked]);

    // No second masking pass on read: what `write` stored is what replays, redactions included.
    expect(archive.tree("root-1")!.events()).toEqual([masked]);
  });
});

describe("run archive — listRoots", () => {
  it("lists only root rows, most recent first, and honours limit and status", () => {
    seedTree("root-1");
    seedTree("root-2");
    finishRun(db, "root-1", "failed");

    expect(archive.listRoots().map((run) => run.runId)).toEqual(["root-2", "root-1"]);
    expect(archive.listRoots({ limit: 1 }).map((run) => run.runId)).toEqual(["root-2"]);
    expect(archive.listRoots({ status: "failed" }).map((run) => run.runId)).toEqual(["root-1"]);
  });
});

describe("run archive — remove and prune", () => {
  it("removes one root run's rows and its directory together, leaving other roots alone", () => {
    seedTree("root-1");
    seedTree("root-2");
    writeRunBlob(dir, "root-1", "root-1", "input.json", {});
    writeRunBlob(dir, "root-2", "root-2", "input.json", {});

    expect(archive.remove("root-1")).toBe(true);
    expect(archive.tree("root-1")).toBeNull();
    expect(existsSync(rootRunTreeDir(dir, "root-1"))).toBe(false);
    expect(archive.tree("root-2")).not.toBeNull();
    expect(existsSync(rootRunTreeDir(dir, "root-2"))).toBe(true);
  });

  it("removes an orphaned directory that has no rows, and reports it as found", () => {
    mkdirSync(rootRunTreeDir(dir, "orphan"), { recursive: true });

    expect(archive.remove("orphan")).toBe(true);
    expect(existsSync(rootRunTreeDir(dir, "orphan"))).toBe(false);
  });

  it("reports false when neither store holds anything for the id", () => {
    expect(archive.remove("never-existed")).toBe(false);
  });

  it("prunes every run from both stores and returns the row count", () => {
    seedTree("root-1");
    seedTree("root-2");
    writeRunBlob(dir, "root-1", "root-1", "input.json", {});

    expect(archive.prune()).toBe(4);
    expect(archive.listRoots()).toEqual([]);
    expect(existsSync(runsDir(dir))).toBe(false);
  });

  it("prunes an orphaned runs directory even when the db held nothing", () => {
    mkdirSync(rootRunTreeDir(dir, "orphan"), { recursive: true });

    expect(archive.prune()).toBe(0);
    expect(existsSync(runsDir(dir))).toBe(false);
  });
});

describe("openRunArchive", () => {
  it("opens a project's own db", () => {
    seedTree();
    db.close();

    const opened = openRunArchive(dir);
    if (!opened.success) throw new Error(opened.error);
    expect(opened.archive.tree("root-1")!.runs).toHaveLength(2);
    opened.close();

    db = openDb(dbFilePath(dir));
  });

  it("answers about a project with no db without creating one, and still clears an orphan", () => {
    const fresh = mkdtempSync(join(tmpdir(), "path-engine-run-archive-nodb-"));
    mkdirSync(rootRunTreeDir(fresh, "orphan"), { recursive: true });

    const opened = openRunArchive(fresh);
    if (!opened.success) throw new Error(opened.error);
    expect(opened.archive.listRoots()).toEqual([]);
    expect(opened.archive.tree("orphan")).toBeNull();
    expect(opened.archive.remove("orphan")).toBe(true);
    opened.close();

    expect(existsSync(rootRunTreeDir(fresh, "orphan"))).toBe(false);
    expect(existsSync(dbFilePath(fresh))).toBe(false);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("reports a db written by another schema version rather than throwing", () => {
    db.pragma("user_version = 99");
    db.close();

    const opened = openRunArchive(dir);
    expect(opened.success).toBe(false);
    if (!opened.success) expect(opened.error).toMatch(/schema version 99/);

    db = openDb(":memory:");
  });
});
