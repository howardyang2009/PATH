import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Bumping this requires a fresh `.path/path.db`: no migration framework pre-1.0 (mvp spec §6). An older
 * or newer db refuses to open with a clear message rather than hitting a missing column or table.
 */
export const SCHEMA_VERSION = 13;

export class SchemaVersionError extends Error {}

const RUNS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    root_run_id TEXT NOT NULL,
    parent_run_id TEXT,
    node_id TEXT,
    node_name TEXT,
    worker_name TEXT,
    iteration INTEGER,
    pass INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending','running','awaiting','succeeded','failed','cancelled')),
    started_at TEXT,
    finished_at TEXT,
    input_ref TEXT,
    output_ref TEXT,
    usage TEXT,
    estimated_cost_usd REAL,
    resumed_from_root_run_id TEXT,
    rerun_from_node_path TEXT,
    reused_from_run_id TEXT,
    workflow_id TEXT,
    workflow_name TEXT,
    workflow_path TEXT,
    launch_facts TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_root_run_id_idx ON runs (root_run_id);
`;

// The db log backend (mvp spec §8.2): envelope fields are columns for queryability, the full event rides
// along as JSON so a row round-trips through LogEventSchema, and `(root_run_id, seq)` is the ordering truth.
const LOG_EVENTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS log_events (
    root_run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT,
    node_name TEXT,
    event TEXT NOT NULL,
    PRIMARY KEY (root_run_id, seq)
  );
`;

/**
 * Opens (creating if absent) the per-project SQLite store. `PRAGMA user_version` distinguishes a fresh
 * db (stamped here) from a mismatched one, which refuses to open rather than migrating (mvp spec §6).
 */
export function openDb(dbFile: string): Database.Database {
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  if (currentVersion === 0) {
    db.exec(RUNS_TABLE_DDL);
    db.exec(LOG_EVENTS_TABLE_DDL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (currentVersion !== SCHEMA_VERSION) {
    db.close();
    throw new SchemaVersionError(
      `${dbFile} was created with schema version ${currentVersion}, this engine expects ${SCHEMA_VERSION}. ` +
        "Delete or recreate path.db to continue (blob files under .path/runs/ are unaffected) — " +
        "there is no migration framework pre-1.0.",
    );
  }

  return db;
}
