import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "@path/schema";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbLogBackend } from "../src/logging/db-backend.js";
import { LOG_FORMAT } from "../src/logging/log-backend.js";
import { openDb } from "../src/persistence/db.js";
import { blobRef, dbFilePath } from "../src/persistence/paths.js";
import { insertRun, setRunOutputRef } from "../src/persistence/run-store.js";
import { createRunArchive, type RunArchive } from "../src/run-archive.js";

/**
 * A root run's rows cross from one store to another (ADR 0091): a sandbox exports them at exit and
 * the host imports them only after forcing the root id, refusing a run id another tree holds, and
 * confining every blob ref to the root's own directory.
 */

let dir: string;
let source: Database.Database;
let host: Database.Database;
let sourceArchive: RunArchive;
let hostArchive: RunArchive;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-run-transfer-test-"));
  source = openDb(dbFilePath(join(dir, "vm")));
  host = openDb(dbFilePath(join(dir, "host")));
  sourceArchive = createRunArchive(source, join(dir, "vm"));
  hostArchive = createRunArchive(host, join(dir, "host"));
});

afterEach(() => {
  source.close();
  host.close();
  rmSync(dir, { recursive: true, force: true });
});

function event(seq: number, runId: string): LogEvent {
  return {
    type: "step-started",
    seq,
    ts: new Date().toISOString(),
    run_id: runId,
    node_id: "greet",
    node_name: "greet",
    step_type: "binary",
    worker_name: "spawn",
  };
}

/** A finished root with one child, its output ref and two log events, written in `db`. */
async function seed(db: Database.Database, rootRunId: string): Promise<void> {
  insertRun(db, {
    runId: rootRunId,
    rootRunId,
    parentRunId: null,
    nodeId: null,
    nodeName: null,
    workerName: null,
    status: "succeeded",
    workflowName: "greet",
  });
  insertRun(db, {
    runId: `${rootRunId}-child`,
    rootRunId,
    parentRunId: rootRunId,
    nodeId: "greet",
    nodeName: "greet",
    workerName: "spawn",
    status: "succeeded",
  });
  setRunOutputRef(db, rootRunId, blobRef(rootRunId, rootRunId, "output.json"));
  const log = createDbLogBackend(db);
  await log.open({ runId: rootRunId, format: LOG_FORMAT });
  await log.write(event(1, rootRunId));
  await log.write(event(2, `${rootRunId}-child`));
}

/** The exported tree as plain JSON, as it crosses the VM boundary. */
function exported(rootRunId: string): { runs: Record<string, unknown>[]; events: unknown[] } {
  return JSON.parse(JSON.stringify(sourceArchive.exportTree(rootRunId)));
}

describe("exportTree", () => {
  it("is null for an unknown root", () => {
    expect(sourceArchive.exportTree("nope")).toBeNull();
  });
});

describe("importTree", () => {
  it("round-trips a tree's rows and events into another store", async () => {
    await seed(source, "root-1");

    expect(hostArchive.importTree("root-1", exported("root-1"))).toEqual({ ok: true });

    const tree = hostArchive.tree("root-1");
    expect(tree?.runs.map((r) => r.runId)).toEqual(["root-1", "root-1-child"]);
    expect(tree?.root?.status).toBe("succeeded");
    expect(tree?.root?.workflowName).toBe("greet");
    expect(tree?.events().map((e) => e.seq)).toEqual([1, 2]);
  });

  it("replaces the rows the host already holds for that root", async () => {
    insertRun(host, {
      runId: "root-1",
      rootRunId: "root-1",
      parentRunId: null,
      nodeId: null,
      nodeName: null,
      workerName: null,
      status: "pending",
    });
    await seed(source, "root-1");

    expect(hostArchive.importTree("root-1", exported("root-1")).ok).toBe(true);
    expect(hostArchive.tree("root-1")?.runs).toHaveLength(2);
  });

  it("forces every row onto the expected root", async () => {
    await seed(source, "root-1");
    const forged = exported("root-1");
    forged.runs[1] = { ...forged.runs[1], root_run_id: "someone-else" };

    expect(hostArchive.importTree("root-1", forged).ok).toBe(true);
    expect(hostArchive.tree("someone-else")).toBeNull();
    expect(hostArchive.tree("root-1")?.runs).toHaveLength(2);
  });

  it("refuses a tree without its root row", async () => {
    await seed(source, "root-1");

    const result = hostArchive.importTree("root-2", exported("root-1"));
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/root row/) });
  });

  it("refuses a run id another tree already holds", async () => {
    await seed(host, "other");
    await seed(source, "root-1");
    const forged = exported("root-1");
    forged.runs[1] = { ...forged.runs[1], run_id: "other-child" };

    const result = hostArchive.importTree("root-1", forged);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/other-child/) });
    expect(hostArchive.tree("root-1")).toBeNull();
    expect(hostArchive.tree("other")?.runs).toHaveLength(2);
  });

  it.each([
    "runs/other/root-1/output.json",
    "runs/root-1/../other/output.json",
    "runs/root-1/root-1/../../x",
    "/etc/passwd",
  ])("refuses the blob ref %s", async (ref) => {
    await seed(source, "root-1");
    const forged = exported("root-1");
    forged.runs[0] = { ...forged.runs[0], output_ref: ref };

    const result = hostArchive.importTree("root-1", forged);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/blob ref/) });
    expect(hostArchive.tree("root-1")).toBeNull();
  });

  it("refuses a row with an unknown column or a bad status", async () => {
    await seed(source, "root-1");
    const extra = exported("root-1");
    extra.runs[0] = { ...extra.runs[0], injected: "x" };
    const badStatus = exported("root-1");
    badStatus.runs[0] = { ...badStatus.runs[0], status: "won" };

    expect(hostArchive.importTree("root-1", extra).ok).toBe(false);
    expect(hostArchive.importTree("root-1", badStatus).ok).toBe(false);
  });

  it("refuses an event naming a run outside the tree", async () => {
    await seed(host, "other");
    await seed(source, "root-1");
    const forged = exported("root-1");
    forged.events[0] = { ...(forged.events[0] as object), run_id: "other-child" };

    expect(hostArchive.importTree("root-1", forged)).toEqual({
      ok: false,
      error: expect.stringMatching(/outside the tree/),
    });
  });

  it("refuses an event that is not a log event", async () => {
    await seed(source, "root-1");
    const forged = exported("root-1");
    forged.events[0] = { ...(forged.events[0] as object), event: '{"type":"nope"}' };

    expect(hostArchive.importTree("root-1", forged).ok).toBe(false);
  });
});
