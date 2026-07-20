import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/logging/log-event.js";
import { getLogEventsForRoot, insertLogEvent } from "../../src/logging/log-store.js";
import { openDb } from "../../src/persistence/db.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-log-store-test-"));
  db = openDb(join(dir, ".path", "path.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function started(seq: number, runId: string, nodeId: string | null): LogEvent {
  return {
    type: "step-started",
    seq,
    ts: "2026-07-19T00:00:00.000Z",
    run_id: runId,
    node_id: nodeId,
    step_type: "binary",
    worker: { type: "engine" },
  };
}

describe("log-store", () => {
  it("round-trips events for a root run, ordered by seq", () => {
    insertLogEvent(db, "root-1", started(2, "step-b", "b"));
    insertLogEvent(db, "root-1", started(1, "step-a", "a"));

    const events = getLogEventsForRoot(db, "root-1");
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]).toMatchObject({ run_id: "step-a", node_id: "a" });
  });

  it("scopes events to their root run", () => {
    insertLogEvent(db, "root-1", started(1, "s1", "a"));
    insertLogEvent(db, "root-2", started(1, "s2", "b"));

    expect(getLogEventsForRoot(db, "root-1")).toHaveLength(1);
    expect(getLogEventsForRoot(db, "root-2")[0]).toMatchObject({ run_id: "s2" });
  });

  it("rejects a duplicate (root_run_id, seq) — seq is unique per root run", () => {
    insertLogEvent(db, "root-1", started(1, "s1", "a"));
    expect(() => insertLogEvent(db, "root-1", started(1, "s2", "b"))).toThrow();
  });
});
