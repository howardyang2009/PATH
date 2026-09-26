import type {
  JsonValue,
  LaunchFacts,
  RerunFromNodePathEntry,
  RunRecord,
  RunStatus,
  TerminalRunStatus,
  WireRunRecord,
} from "@path/schema";
import { fromWireRunRecord } from "@path/schema";
import type Database from "better-sqlite3";

// `RunStatus`, `RUN_STATUSES` and `RunRecord` are domain vocabulary and live in @path/schema; this module owns how a
// run is *stored*.
export { RUN_STATUSES, type RunRecord, type RunStatus } from "@path/schema";

export interface NewRunRow {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  nodeName: string | null;
  /** A leaf step run's worker *name* (ADR 0021 sub-14); null for a workflow-run's own row. */
  workerName: string | null;
  /** A `while-do` iteration container's 1-based ordinal (ADR 0037); null on every other row. */
  iteration?: number | null;
  /** A goto pass container's 1-based ordinal (ADR 0054); null on every other row. */
  pass?: number | null;
  status: RunStatus;
  inputRef?: string;
  /** Meaningful only on a root row: the predecessor's root run id for a resumed tree. */
  resumedFromRootRunId?: string | null;
  /** Root-only (ADR 0032): the rerun boundary (K) descent path a Resume-from-K successor resumed from; JSON TEXT. */
  rerunFromNodePath?: RerunFromNodePathEntry[] | null;
  /** Root-only (ADR 0006): the producing workflow's GUID `id`. */
  workflowId?: string | null;
  workflowName?: string | null;
  workflowPath?: string | null;
  /**
   * Root-only (ADR 0046): the operator's frozen **launch facts** — input override, `$env`-resolved and
   * `$secret`-masked config override, launch worker-default table (ADR 0044), and secret config paths — as JSON TEXT.
   */
  launchFacts?: LaunchFacts | null;
}

export function insertRun(db: Database.Database, row: NewRunRow): void {
  db.prepare(
    `INSERT INTO runs (run_id, root_run_id, parent_run_id, node_id, node_name, worker_name, iteration, pass, status, started_at, input_ref, resumed_from_root_run_id, rerun_from_node_path, workflow_id, workflow_name, workflow_path, launch_facts)
     VALUES (@runId, @rootRunId, @parentRunId, @nodeId, @nodeName, @workerName, @iteration, @pass, @status, @startedAt, @inputRef, @resumedFromRootRunId, @rerunFromNodePath, @workflowId, @workflowName, @workflowPath, @launchFacts)`,
  ).run({
    runId: row.runId,
    rootRunId: row.rootRunId,
    parentRunId: row.parentRunId,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    workerName: row.workerName,
    iteration: row.iteration ?? null,
    pass: row.pass ?? null,
    status: row.status,
    startedAt: new Date().toISOString(),
    inputRef: row.inputRef ?? null,
    resumedFromRootRunId: row.resumedFromRootRunId ?? null,
    // JSON-encoded descent path, root-only; null on plain Resume and every nested row.
    rerunFromNodePath: row.rerunFromNodePath ? JSON.stringify(row.rerunFromNodePath) : null,
    workflowId: row.workflowId ?? null,
    workflowName: row.workflowName ?? null,
    workflowPath: row.workflowPath ?? null,
    // JSON-encoded launch facts, root-only; null on every nested row and a launch that supplied nothing (ADR 0046).
    launchFacts: row.launchFacts ? JSON.stringify(row.launchFacts) : null,
  });
}

/**
 * A **reuse row**: the whole record of a node a resumed tree reused, written in one shot — a reuse neither ran
 * nor produced blobs. `status` is always `succeeded`, `reusedFromRunId` names the source run (ADR 0001), and every
 * execution-only column stays null so spend is never double-counted. */
export function insertReuseRun(
  db: Database.Database,
  row: {
    runId: string;
    rootRunId: string;
    parentRunId: string;
    nodeId: string;
    nodeName: string | null;
    reusedFromRunId: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (run_id, root_run_id, parent_run_id, node_id, node_name, status, started_at, finished_at, reused_from_run_id)
     VALUES (@runId, @rootRunId, @parentRunId, @nodeId, @nodeName, 'succeeded', @now, @now, @reusedFromRunId)`,
  ).run({
    runId: row.runId,
    rootRunId: row.rootRunId,
    parentRunId: row.parentRunId,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    now,
    reusedFromRunId: row.reusedFromRunId,
  });
}

/** Move a run to a non-terminal status without stamping `finished_at` (the `awaiting` transition). A terminal
 * status is rejected at the type level — it belongs to `finishRun`, which also stamps the finish. */
export function setRunStatus(
  db: Database.Database,
  runId: string,
  status: Exclude<RunStatus, TerminalRunStatus>,
): void {
  db.prepare(`UPDATE runs SET status = @status WHERE run_id = @runId`).run({ status, runId });
}

export function finishRun(db: Database.Database, runId: string, status: TerminalRunStatus): void {
  db.prepare(
    `UPDATE runs SET status = @status, finished_at = @finishedAt WHERE run_id = @runId`,
  ).run({
    status,
    finishedAt: new Date().toISOString(),
    runId,
  });
}

/** Cancel a **parked** tree's every non-terminal run in one write (`awaiting → cancelled`, ADR 0041). Only
 * for a tree not executing live — nothing then races these rows; a live tree uses its `AbortController`. */
export function cancelNonTerminalRuns(db: Database.Database, rootRunId: string): number {
  const info = db
    .prepare(
      `UPDATE runs SET status = 'cancelled', finished_at = @finishedAt
       WHERE root_run_id = @rootRunId AND status IN ('pending', 'running', 'awaiting')`,
    )
    .run({ finishedAt: new Date().toISOString(), rootRunId });
  return info.changes;
}

/** The output ref lands on its own UPDATE because it cannot be known at insert time — a run's output exists
 * only once it succeeded. The *input* ref goes in with the row, so it has no setter. */
export function setRunOutputRef(db: Database.Database, runId: string, outputRef: string): void {
  db.prepare(`UPDATE runs SET output_ref = @ref WHERE run_id = @runId`).run({
    ref: outputRef,
    runId,
  });
}

/** What one LLM run spent (mvp spec §5.7): `usage` is the worker's real token counts, stored verbatim;
 * `estimatedCostUsd` is the SDK's client-side estimate at list prices — notional under subscription billing. */
export interface RunUsage {
  usage: JsonValue | null;
  estimatedCostUsd: number | null;
}

export function setRunUsage(db: Database.Database, runId: string, spend: RunUsage): void {
  db.prepare(
    `UPDATE runs SET usage = @usage, estimated_cost_usd = @cost WHERE run_id = @runId`,
  ).run({
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
  node_name: string | null;
  worker_name: string | null;
  iteration: number | null;
  pass: number | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  input_ref: string | null;
  output_ref: string | null;
  usage: string | null;
  estimated_cost_usd: number | null;
  resumed_from_root_run_id: string | null;
  rerun_from_node_path: string | null;
  reused_from_run_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  workflow_path: string | null;
}

function fromDbRow(row: RunRowDb): RunRecord {
  // The db row is already the wire shape (snake_case) bar a few columns stored differently; normalize those,
  // then let the one wire codec map every field, so a new `RunRecord` field reaches this read from the manifest.
  const wire: WireRunRecord = {
    ...row,
    // Stored as JSON TEXT; the wire/domain shape is the parsed value.
    usage: row.usage ? (JSON.parse(row.usage) as JsonValue) : null,
    rerun_from_node_path: row.rerun_from_node_path
      ? (JSON.parse(row.rerun_from_node_path) as RerunFromNodePathEntry[])
      : null,
    // Not a stored column: the archive read path resolves the source run's root on demand; a bare row leaves it null.
    reused_from_root_run_id: null,
  };
  return fromWireRunRecord(wire);
}

/** One run row by its own id, or undefined. Resume resolves a reuse row's `reusedFromRunId` through it to
 * the source record in an ancestor tree; undefined means that tree was `rm`'d, i.e. no data to reuse (ADR 0001). */
export function getRun(db: Database.Database, runId: string): RunRecord | undefined {
  const row = db.prepare(`SELECT * FROM runs WHERE run_id = @runId`).get({ runId }) as
    | RunRowDb
    | undefined;
  return row ? fromDbRow(row) : undefined;
}

export function getRunsForRoot(db: Database.Database, rootRunId: string): RunRecord[] {
  const rows = db
    .prepare(`SELECT * FROM runs WHERE root_run_id = @rootRunId ORDER BY started_at, rowid`)
    .all({ rootRunId }) as RunRowDb[];
  return rows.map(fromDbRow);
}

/** The frozen **launch facts** a run recorded on its own root row (ADR 0046), or `undefined` when the run
 * supplied nothing beyond the file or no row has that id. The one read of the JSON column. */
export function getLaunchFacts(db: Database.Database, rootRunId: string): LaunchFacts | undefined {
  const row = db
    .prepare(`SELECT launch_facts FROM runs WHERE run_id = @rootRunId`)
    .get({ rootRunId }) as { launch_facts: string | null } | undefined;
  if (!row || row.launch_facts === null) return undefined;
  return JSON.parse(row.launch_facts) as LaunchFacts;
}

/**
 * The frozen **launch worker-default** table a run recorded on its own root row (ADR 0044), or `undefined`
 * when none; a projection of {@link getLaunchFacts}. Identity-defining like `input`, so resume/complete restore it
 * from here, not the request.
 */
export function getLaunchWorkerDefaults(
  db: Database.Database,
  rootRunId: string,
): { [stepType: string]: string } | undefined {
  return getLaunchFacts(db, rootRunId)?.workerDefaults;
}

/** The root run id of the tree a run belongs to, or `null` when no row has that id. The cost SUM uses it to
 * reach a reuse marker's tree; `null` means that tree was `rm`'d, read as "no recorded data", not an error. */
export function rootRunIdOf(db: Database.Database, runId: string): string | null {
  const row = db.prepare(`SELECT root_run_id FROM runs WHERE run_id = @runId`).get({ runId }) as
    | { root_run_id: string }
    | undefined;
  return row ? row.root_run_id : null;
}

export interface ListRootRunsOptions {
  /** Cap on the number of root runs returned; server-api-v0.md §3 default. */
  limit?: number;
  status?: RunStatus;
  workflowName?: string;
  workflowId?: string;
}

/** Lists root runs — rows whose own id is the tree root, one per tree — most-recent-first
 * (server-api-v0.md §3). The `rowid DESC` tiebreaker keeps ordering stable when two roots share a millisecond. */
export function listRootRuns(
  db: Database.Database,
  options: ListRootRunsOptions = {},
): RunRecord[] {
  const limit = options.limit ?? 50;
  const params: { limit: number; status?: RunStatus; workflowName?: string; workflowId?: string } =
    { limit };
  let filterClause = "";
  if (options.status !== undefined) {
    filterClause += " AND status = @status";
    params.status = options.status;
  }
  // Root-only columns: a nested row's `workflow_name`/`workflow_id` is always null, so matching a non-null
  // value can never pick up a nested row.
  if (options.workflowName !== undefined) {
    filterClause += " AND workflow_name = @workflowName";
    params.workflowName = options.workflowName;
  }
  if (options.workflowId !== undefined) {
    filterClause += " AND workflow_id = @workflowId";
    params.workflowId = options.workflowId;
  }
  const rows = db
    .prepare(
      `SELECT * FROM runs WHERE run_id = root_run_id${filterClause} ORDER BY started_at DESC, rowid DESC LIMIT @limit`,
    )
    .all(params) as RunRowDb[];
  return rows.map(fromDbRow);
}

/** Which of the given run ids still have a row, as a set. Rendering `resumed-from` uses existence — not
 * membership of any listing page — to tell a live predecessor from one since `runs rm`'d (rendered `(deleted)`). */
export function existingRunIds(db: Database.Database, ids: readonly string[]): Set<string> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT run_id FROM runs WHERE run_id IN (${placeholders})`)
    .all(...unique) as { run_id: string }[];
  return new Set(rows.map((row) => row.run_id));
}

/** Used by `path runs rm <root-run-id>` (mvp spec §6) — deletes one root run's rows. */
export function deleteRunsForRoot(db: Database.Database, rootRunId: string): number {
  return db.prepare(`DELETE FROM runs WHERE root_run_id = @rootRunId`).run({ rootRunId }).changes;
}

/** Used by `path runs prune` (mvp spec §6) — deletes every root run's rows. */
export function deleteAllRuns(db: Database.Database): number {
  return db.prepare(`DELETE FROM runs`).run().changes;
}
