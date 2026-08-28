import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Bumping this requires a fresh `.path/path.db` — there is no migration framework pre-1.0
 * (mvp spec §6); anticipates the full run-row shape of spec §5.7 (including the `usage`/
 * `estimated_cost_usd` columns #25's LLM worker will populate) so this ticket's schema doesn't
 * need to bump again once #25 lands.
 *
 * Bumped to 2 in #19 to add the `log_events` table (the db log backend, mvp spec §8.2) — an
 * existing pre-#19 db (version 1, no log table) refuses to open with a clear message rather than
 * silently lacking the table a run would then fail to write to.
 *
 * Bumped to 3 in #169 to add `runs.resumed_from_root_run_id` (meaningful only on root rows — the
 * immediate predecessor's root run id, set once at a successor root run's insert time; #168's
 * resume feature). Same precedent as the #19 bump: an existing pre-#169 db refuses to open rather
 * than silently lacking the column a resumed run would then fail to write to.
 *
 * Bumped to 4 in #204 for the identity migration (ADR 0006/0007): `runs.node_id` and every log
 * event's `node_id` now carry the durable GUID, and a `node_name` column is added to both `runs` and
 * `log_events` so the run tree and log stream stay human-readable without re-loading the workflow.
 * Bump-and-break with no migration (pre-1.0): the store is a clean slate, so no old row carries a
 * stale human `node_id`. Blobs under `.path/runs/` are unaffected.
 *
 * Bumped to 5 in #202 for source-workflow identity (ADR 0006): a root run now records the producing
 * workflow's `workflow_id` (GUID), `workflow_name` (human label) and `workflow_path` (path relative
 * to the store dir) so a central `-C` store (ADR 0005) can tell one workflow's runs from another's
 * rather than listing an anonymous pile of run-ids. Root-only — the three columns are null on every
 * nested row, whose own producing node is already carried by `node_id`/`node_name`. ADR 0006 costed
 * this as part of the same v3→v4 bump; the work split across two tickets (#204 shipped v4), so it
 * lands as v5. Same bump-and-break, clean-slate reading: no backfill, no old root row left null.
 *
 * Bumped to 6 in #257 for chained-resume reuse rows: a reused node now records a real `succeeded` row
 * of its own (rather than only a log marker), so `runs` gains `reused_from_run_id` — the source run
 * that row reuses, direct-to-source (ADR 0001). Null on every executed row. Same bump-and-break: an
 * existing pre-#257 db refuses to open rather than silently lacking the column a reuse row writes to.
 *
 * Bumped to 7 in #332 for the worker-name migration (ADR 0021 sub-14): a worker is a *name* now, so
 * the `runs.worker` column (which held a JSON-encoded `{type, model, …}` object) becomes
 * `runs.worker_name`, a bare string — the resolved worker name a leaf step ran on, null on a
 * workflow-run's own row. Clean-slate bump-and-break, no backfill: an existing pre-#332 db refuses to
 * open rather than reading the old object-shaped column as a name.
 */
export const SCHEMA_VERSION = 7;

export class SchemaVersionError extends Error {}

const RUNS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    root_run_id TEXT NOT NULL,
    parent_run_id TEXT,
    node_id TEXT,
    node_name TEXT,
    worker_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
    started_at TEXT,
    finished_at TEXT,
    input_ref TEXT,
    output_ref TEXT,
    usage TEXT,
    estimated_cost_usd REAL,
    resumed_from_root_run_id TEXT,
    reused_from_run_id TEXT,
    workflow_id TEXT,
    workflow_name TEXT,
    workflow_path TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_root_run_id_idx ON runs (root_run_id);
`;

// The db log backend (mvp spec §8.2). Envelope fields are stored as columns for queryability; the
// full event (envelope + payload) rides along as JSON so the stored row round-trips back through
// LogEventSchema. `seq` is monotonic per root run, so (root_run_id, seq) is the natural key and the
// ordering truth — reads sort by it.
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
