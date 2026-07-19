import type Database from "better-sqlite3";
import type { Worker } from "@path/schema";

/** Run rows exist for step runs only (domain invariant 1); mvp spec §5.7. */
export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface NewRunRow {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  worker: Worker | null;
  status: RunStatus;
}

export function insertRun(db: Database.Database, row: NewRunRow): void {
  db.prepare(
    `INSERT INTO runs (run_id, root_run_id, parent_run_id, node_id, worker, status, started_at)
     VALUES (@runId, @rootRunId, @parentRunId, @nodeId, @worker, @status, @startedAt)`,
  ).run({
    runId: row.runId,
    rootRunId: row.rootRunId,
    parentRunId: row.parentRunId,
    nodeId: row.nodeId,
    worker: row.worker ? JSON.stringify(row.worker) : null,
    status: row.status,
    startedAt: new Date().toISOString(),
  });
}

export function finishRun(db: Database.Database, runId: string, status: "succeeded" | "failed" | "cancelled"): void {
  db.prepare(`UPDATE runs SET status = @status, finished_at = @finishedAt WHERE run_id = @runId`).run({
    status,
    finishedAt: new Date().toISOString(),
    runId,
  });
}

export function setRunBlobRefs(
  db: Database.Database,
  runId: string,
  refs: { inputRef?: string; outputRef?: string },
): void {
  if (refs.inputRef !== undefined) {
    db.prepare(`UPDATE runs SET input_ref = @ref WHERE run_id = @runId`).run({ ref: refs.inputRef, runId });
  }
  if (refs.outputRef !== undefined) {
    db.prepare(`UPDATE runs SET output_ref = @ref WHERE run_id = @runId`).run({ ref: refs.outputRef, runId });
  }
}

export interface RunRecord {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  worker: Worker | null;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  inputRef: string | null;
  outputRef: string | null;
}

interface RunRowDb {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  node_id: string | null;
  worker: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  input_ref: string | null;
  output_ref: string | null;
}

function fromDbRow(row: RunRowDb): RunRecord {
  return {
    runId: row.run_id,
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id,
    nodeId: row.node_id,
    worker: row.worker ? (JSON.parse(row.worker) as Worker) : null,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    inputRef: row.input_ref,
    outputRef: row.output_ref,
  };
}

export function getRunsForRoot(db: Database.Database, rootRunId: string): RunRecord[] {
  const rows = db
    .prepare(`SELECT * FROM runs WHERE root_run_id = @rootRunId ORDER BY started_at`)
    .all({ rootRunId }) as RunRowDb[];
  return rows.map(fromDbRow);
}

/** Used by `path runs rm <root-run-id>` (mvp spec §6) — deletes one root run's rows. */
export function deleteRunsForRoot(db: Database.Database, rootRunId: string): number {
  return db.prepare(`DELETE FROM runs WHERE root_run_id = @rootRunId`).run({ rootRunId }).changes;
}

/** Used by `path runs prune` (mvp spec §6) — deletes every root run's rows. */
export function deleteAllRuns(db: Database.Database): number {
  return db.prepare(`DELETE FROM runs`).run().changes;
}
