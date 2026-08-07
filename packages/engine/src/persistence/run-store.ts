import type Database from "better-sqlite3";
import type { JsonValue, RunRecord, RunStatus, TerminalRunStatus, Worker } from "@path/schema";

// `RunStatus`, `RUN_STATUSES` and `RunRecord` are domain vocabulary and live in @path/schema (#66).
// What lives here is how a run is *stored*: the row shape, the SQL, and the mapping between them.
export { RUN_STATUSES, type RunStatus, type RunRecord } from "@path/schema";

export interface NewRunRow {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  worker: Worker | null;
  status: RunStatus;
  /** Written with the row: the input blob is always on disk before the row exists (#72). */
  inputRef?: string;
  /** Meaningful only on a root row (#168): the predecessor's root run id for a resumed tree. */
  resumedFromRootRunId?: string | null;
}

export function insertRun(db: Database.Database, row: NewRunRow): void {
  db.prepare(
    `INSERT INTO runs (run_id, root_run_id, parent_run_id, node_id, worker, status, started_at, input_ref, resumed_from_root_run_id)
     VALUES (@runId, @rootRunId, @parentRunId, @nodeId, @worker, @status, @startedAt, @inputRef, @resumedFromRootRunId)`,
  ).run({
    runId: row.runId,
    rootRunId: row.rootRunId,
    parentRunId: row.parentRunId,
    nodeId: row.nodeId,
    worker: row.worker ? JSON.stringify(row.worker) : null,
    status: row.status,
    startedAt: new Date().toISOString(),
    inputRef: row.inputRef ?? null,
    resumedFromRootRunId: row.resumedFromRootRunId ?? null,
  });
}

export function finishRun(db: Database.Database, runId: string, status: TerminalRunStatus): void {
  db.prepare(`UPDATE runs SET status = @status, finished_at = @finishedAt WHERE run_id = @runId`).run({
    status,
    finishedAt: new Date().toISOString(),
    runId,
  });
}

/**
 * The output ref lands on its own UPDATE because it cannot be known at insert time — a run's output
 * exists only once the run has succeeded. The *input* ref goes in with the row (`insertRun`), which
 * is why there is no setter for it (#72).
 */
export function setRunOutputRef(db: Database.Database, runId: string, outputRef: string): void {
  db.prepare(`UPDATE runs SET output_ref = @ref WHERE run_id = @runId`).run({ ref: outputRef, runId });
}

/**
 * What one LLM run spent (mvp spec §5.7, §7): `usage` is the worker's real token counts, stored
 * verbatim; `estimatedCostUsd` is the SDK's client-side estimate at API list prices — real for
 * API-key users, notional under subscription billing. Recorded **leaf-only**, on the prompt-step
 * runs where the tokens were actually spent.
 */
export interface RunUsage {
  usage: JsonValue | null;
  estimatedCostUsd: number | null;
}

export function setRunUsage(db: Database.Database, runId: string, spend: RunUsage): void {
  db.prepare(`UPDATE runs SET usage = @usage, estimated_cost_usd = @cost WHERE run_id = @runId`).run({
    usage: spend.usage === null ? null : JSON.stringify(spend.usage),
    cost: spend.estimatedCostUsd,
    runId,
  });
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
  usage: string | null;
  estimated_cost_usd: number | null;
  resumed_from_root_run_id: string | null;
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
    usage: row.usage ? (JSON.parse(row.usage) as JsonValue) : null,
    estimatedCostUsd: row.estimated_cost_usd,
    resumedFromRootRunId: row.resumed_from_root_run_id,
  };
}

export function getRunsForRoot(db: Database.Database, rootRunId: string): RunRecord[] {
  const rows = db
    .prepare(`SELECT * FROM runs WHERE root_run_id = @rootRunId ORDER BY started_at`)
    .all({ rootRunId }) as RunRowDb[];
  return rows.map(fromDbRow);
}

export interface ListRootRunsOptions {
  /** Cap on the number of root runs returned; server-api-v0.md §3 default. */
  limit?: number;
  /** Optional filter: return only root runs in this status. */
  status?: RunStatus;
}

/**
 * Lists root runs — the rows whose own id is the tree root (`run_id = root_run_id`), one per run
 * tree — most-recent-first (server-api-v0.md §3). `getRunsForRoot` needs a known id and returns a
 * whole tree; this is the complementary "which root runs exist" query. The `rowid DESC` tiebreaker
 * keeps ordering stable when two roots share a `started_at` millisecond.
 */
export function listRootRuns(db: Database.Database, options: ListRootRunsOptions = {}): RunRecord[] {
  const limit = options.limit ?? 50;
  const params: { limit: number; status?: RunStatus } = { limit };
  let statusClause = "";
  if (options.status !== undefined) {
    statusClause = " AND status = @status";
    params.status = options.status;
  }
  const rows = db
    .prepare(
      `SELECT * FROM runs WHERE run_id = root_run_id${statusClause} ORDER BY started_at DESC, rowid DESC LIMIT @limit`,
    )
    .all(params) as RunRowDb[];
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
