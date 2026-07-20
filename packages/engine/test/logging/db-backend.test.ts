import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbLogBackend } from "../../src/logging/db-backend.js";
import type { LogEvent } from "../../src/logging/log-event.js";
import { getLogEventsForRoot } from "../../src/logging/log-store.js";
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

function finished(seq: number): LogEvent {
  return { type: "step-finished", seq, ts: "t", run_id: "root-1", node_id: null, status: "succeeded" };
}

describe("createDbLogBackend", () => {
  it("stamps every written event with the root run id from open() and reads back in seq order", async () => {
    const backend = createDbLogBackend(db);
    await backend.open({ runId: "root-1", format: "path/log@0" });
    await backend.write(finished(1));
    await backend.write(finished(2));
    await backend.close();

    const events = getLogEventsForRoot(db, "root-1");
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("rejects a write before open — nothing to scope the row under", async () => {
    const backend = createDbLogBackend(db);
    await expect(backend.write(finished(1))).rejects.toThrow();
  });
});
