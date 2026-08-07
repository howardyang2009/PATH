import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, SCHEMA_VERSION, SchemaVersionError } from "../../src/persistence/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-db-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("creates the db file and its parent directory, stamping the current schema version", () => {
    const dbFile = join(dir, "nested", "path.db");
    const db = openDb(dbFile);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("creates the runs table with the documented columns", () => {
    const db = openDb(join(dir, "path.db"));
    const columns = (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "run_id",
        "root_run_id",
        "parent_run_id",
        "node_id",
        "worker",
        "status",
        "started_at",
        "finished_at",
        "input_ref",
        "output_ref",
        "usage",
        "estimated_cost_usd",
        "resumed_from_root_run_id",
      ]),
    );
    db.close();
  });

  it("creates the log_events table with the documented columns", () => {
    const db = openDb(join(dir, "path.db"));
    const columns = (db.prepare("PRAGMA table_info(log_events)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining(["root_run_id", "seq", "ts", "type", "run_id", "node_id", "event"]),
    );
    db.close();
  });

  it("reopens an already-initialized db at the same version without error", () => {
    const dbFile = join(dir, "path.db");
    openDb(dbFile).close();
    const db = openDb(dbFile);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("refuses to open a db stamped with a different schema version", () => {
    const dbFile = join(dir, "path.db");
    const raw = new Database(dbFile);
    raw.pragma("user_version = 999");
    raw.close();

    expect(() => openDb(dbFile)).toThrow(SchemaVersionError);
    expect(() => openDb(dbFile)).toThrow(/999/);
  });

  it("refuses to open a pre-#169 version-2 db (no resumed_from_root_run_id column)", () => {
    const dbFile = join(dir, "path.db");
    const raw = new Database(dbFile);
    raw.pragma("user_version = 2");
    raw.close();

    expect(() => openDb(dbFile)).toThrow(SchemaVersionError);
    expect(() => openDb(dbFile)).toThrow(/2/);
  });
});
