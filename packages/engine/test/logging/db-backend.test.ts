import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogEvent } from "@path/schema";
import { createDbLogBackend, getLogEventsForRoot } from "../../src/logging/db-backend.js";
import { openDb } from "../../src/persistence/db.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-db-backend-test-"));
  db = openDb(join(dir, ".path", "path.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function finished(seq: number, runId = "root-1"): LogEvent {
  return { type: "step-finished", seq, ts: "t", run_id: runId, node_id: null, status: "succeeded" };
}

/** A backend already open on the given root run — the only way a row reaches `log_events`. */
async function openedOn(rootRunId: string) {
  const backend = createDbLogBackend(db);
  await backend.open({ runId: rootRunId, format: "path/log@0" });
  return backend;
}

describe("createDbLogBackend", () => {
  it("stamps every written event with the root run id from open()", async () => {
    const backend = await openedOn("root-1");
    await backend.write(finished(1));
    await backend.write(finished(2));
    await backend.close();

    expect(getLogEventsForRoot(db, "root-1").map((e) => e.seq)).toEqual([1, 2]);
  });

  // `seq` is the ordering truth, not arrival: a reader must not depend on insertion order.
  it("reads back in seq order, whatever order the events were written in", async () => {
    const backend = await openedOn("root-1");
    await backend.write(finished(2, "step-b"));
    await backend.write(finished(1, "step-a"));

    const events = getLogEventsForRoot(db, "root-1");
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]).toMatchObject({ run_id: "step-a" });
  });

  it("scopes events to their own root run", async () => {
    const one = await openedOn("root-1");
    const two = await openedOn("root-2");
    await one.write(finished(1, "s1"));
    await two.write(finished(1, "s2"));

    expect(getLogEventsForRoot(db, "root-1")).toHaveLength(1);
    expect(getLogEventsForRoot(db, "root-2")[0]).toMatchObject({ run_id: "s2" });
  });

  it("rejects a duplicate (root_run_id, seq) — seq is unique per root run", async () => {
    const backend = await openedOn("root-1");
    await backend.write(finished(1, "s1"));

    await expect(backend.write(finished(1, "s2"))).rejects.toThrow();
  });

  it("rejects a write before open — nothing to scope the row under", async () => {
    const backend = createDbLogBackend(db);
    await expect(backend.write(finished(1))).rejects.toThrow();
  });
});
