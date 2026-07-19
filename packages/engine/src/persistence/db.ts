import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Bumping this requires a fresh `.path/path.db` — there is no migration framework pre-1.0
 * (mvp spec §6); anticipates the full run-row shape of spec §5.7 (including the `usage`/
 * `estimated_cost_usd` columns #25's LLM worker will populate) so this ticket's schema doesn't
 * need to bump again once #25 lands.
 */
export const SCHEMA_VERSION = 1;

export class SchemaVersionError extends Error {}

const RUNS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    root_run_id TEXT NOT NULL,
    parent_run_id TEXT,
    node_id TEXT,
    worker TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
    started_at TEXT,
    finished_at TEXT,
    input_ref TEXT,
    output_ref TEXT,
    usage TEXT,
    estimated_cost_usd REAL
  );
  CREATE INDEX IF NOT EXISTS runs_root_run_id_idx ON runs (root_run_id);
`;

/**
 * Opens (creating if absent) the per-project SQLite store. `PRAGMA user_version` (mvp spec §6)
 * distinguishes a fresh db (version 0 — initialized and stamped here) from a mismatched one,
 * which refuses to open with a clear message rather than attempting any migration.
 */
export function openDb(dbFile: string): Database.Database {
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  if (currentVersion === 0) {
    db.exec(RUNS_TABLE_DDL);
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
