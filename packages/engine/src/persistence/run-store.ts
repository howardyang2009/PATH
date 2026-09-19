import type Database from "better-sqlite3";
import { fromWireRunRecord } from "@path/schema";
import type { JsonValue, RerunFromNodePathEntry, RunRecord, RunStatus, TerminalRunStatus, WireRunRecord } from "@path/schema";

// `RunStatus`, `RUN_STATUSES` and `RunRecord` are domain vocabulary and live in @path/schema (#66).
// What lives here is how a run is *stored*: the row shape, the SQL, and the mapping between them.
export { RUN_STATUSES, type RunStatus, type RunRecord } from "@path/schema";

export interface NewRunRow {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  nodeName: string | null;
  /** A leaf step run's worker *name* (ADR 0021 sub-14); null for a workflow-run's own row. */
  workerName: string | null;
  /** A `while-do` iteration container's 1-based ordinal (ADR 0037); null/undefined on every other row. */
  iteration?: number | null;
  status: RunStatus;
  /** Written with the row: the input blob is always on disk before the row exists (#72). */
  inputRef?: string;
  /** Meaningful only on a root row (#168): the predecessor's root run id for a resumed tree. */
  resumedFromRootRunId?: string | null;
  /**
   * Root-only (#444, ADR 0032): the rerun boundary (K) descent path a Resume-from-K successor
   * resumed from, `{nodeId, nodeName}[]`. Null/undefined on plain Resume and every nested row. Stored
   * as JSON TEXT.
   */
  rerunFromNodePath?: RerunFromNodePathEntry[] | null;
  /** Source-workflow identity, meaningful only on a root row (#202, ADR 0006): the producing workflow's GUID `id`. */
  workflowId?: string | null;
  /** Root-only (#202): the producing workflow's human `name`. */
  workflowName?: string | null;
  /** Root-only (#202): the producing `workflow.json` path, relative to the store dir. */
  workflowPath?: string | null;
  /**
   * Root-only (#519, ADR 0044): the operator's frozen **launch worker-default** table
   * (`{ <stepType>: <workerName> }`), stored as JSON TEXT. Undefined/null on every row but a fresh
   * launch's root — a resume/Complete reads it back through `getLaunchWorkerDefaults` so a re-run step
   * resolves to the worker the launch chose. It is engine-internal, so it never joins `RunRecord`.
   */
  launchWorkerDefaults?: { [stepType: string]: string } | null;
}

export function insertRun(db: Database.Database, row: NewRunRow): void {
  db.prepare(
    `INSERT INTO runs (run_id, root_run_id, parent_run_id, node_id, node_name, worker_name, iteration, status, started_at, input_ref, resumed_from_root_run_id, rerun_from_node_path, workflow_id, workflow_name, workflow_path, launch_worker_defaults)
     VALUES (@runId, @rootRunId, @parentRunId, @nodeId, @nodeName, @workerName, @iteration, @status, @startedAt, @inputRef, @resumedFromRootRunId, @rerunFromNodePath, @workflowId, @workflowName, @workflowPath, @launchWorkerDefaults)`,
  ).run({
    runId: row.runId,
    rootRunId: row.rootRunId,
    parentRunId: row.parentRunId,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    // A bare string now (ADR 0021 sub-14): the JSON.stringify the object-shaped worker needed is gone.
    workerName: row.workerName,
    // A `while-do` iteration container's ordinal (ADR 0037); null on every other run kind.
    iteration: row.iteration ?? null,
    status: row.status,
    startedAt: new Date().toISOString(),
    inputRef: row.inputRef ?? null,
    resumedFromRootRunId: row.resumedFromRootRunId ?? null,
    // JSON-encoded descent path, root-only; null on plain Resume and every nested row (#444).
    rerunFromNodePath: row.rerunFromNodePath ? JSON.stringify(row.rerunFromNodePath) : null,
    workflowId: row.workflowId ?? null,
    workflowName: row.workflowName ?? null,
    workflowPath: row.workflowPath ?? null,
    // JSON-encoded launch table, root-only; null on every nested row and a launch that supplied none (#519).
    launchWorkerDefaults: row.launchWorkerDefaults ? JSON.stringify(row.launchWorkerDefaults) : null,
  });
}

/**
 * A **reuse row** (#257): the whole record of a node a resumed tree reused, written in one shot
 * because a reuse has no start/finish pair — it neither ran nor produced blobs. `status` is always
 * `succeeded` (a node only reuses a succeeded original), `reusedFromRunId` names the source run whose
 * output it reuses (direct-to-source, ADR 0001), and every execution-only column stays null: no
 * input/output ref (the payload lives under the source run), no worker, no usage/cost (never
 * double-counted — the spend lives under the source too). `startedAt`/`finishedAt` are stamped now so
 * the row sorts into the tree at the point of reuse.
 */
export function insertReuseRun(
  db: Database.Database,
  row: { runId: string; rootRunId: string; parentRunId: string; nodeId: string; nodeName: string | null; reusedFromRunId: string },
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

/**
 * Move a run to a non-terminal status without stamping `finished_at` — the transition into
 * `awaiting` (#462). A terminal status is rejected at the type level: it belongs to `finishRun`,
 * which also stamps `finished_at`, so routing one here would leave a "done" row with a null finish.
 */
export function setRunStatus(db: Database.Database, runId: string, status: Exclude<RunStatus, TerminalRunStatus>): void {
  db.prepare(`UPDATE runs SET status = @status WHERE run_id = @runId`).run({ status, runId });
}

export function finishRun(db: Database.Database, runId: string, status: TerminalRunStatus): void {
  db.prepare(`UPDATE runs SET status = @status, finished_at = @finishedAt WHERE run_id = @runId`).run({
    status,
    finishedAt: new Date().toISOString(),
    runId,
  });
}

/**
 * Cancel a **parked** tree's every non-terminal run in one write — an `awaiting` leaf and the
 * `running` workflow-runs above it (ADR 0041: `awaiting → cancelled`). Used only when the tree is not
 * executing live (no held process to abort, ADR 0039 teardown), so there is nothing racing these rows
 * inside the transition; a live tree is cancelled through its `AbortController` instead. `pending` is
 * included for completeness though no row rests there after start. Returns the number of rows moved.
 */
export function cancelNonTerminalRuns(db: Database.Database, rootRunId: string): number {
  const info = db
    .prepare(
      `UPDATE runs SET status = 'cancelled', finished_at = @finishedAt
       WHERE root_run_id = @rootRunId AND status IN ('pending', 'running', 'awaiting')`,
    )
    .run({ finishedAt: new Date().toISOString(), rootRunId });
  return info.changes;
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
  node_name: string | null;
  worker_name: string | null;
  iteration: number | null;
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
  // The db row is the wire shape already (snake_case), bar three columns the store stores differently.
  // Normalize those, then let the one wire codec (`fromWireRunRecord`) map every field to the domain
  // record — so a field added to `RunRecord` reaches this read from the shared manifest, not a hand-copy.
  const wire: WireRunRecord = {
    ...row,
    // Stored as JSON TEXT; the wire/domain shape is the parsed value.
    usage: row.usage ? (JSON.parse(row.usage) as JsonValue) : null,
    rerun_from_node_path: row.rerun_from_node_path
      ? (JSON.parse(row.rerun_from_node_path) as RerunFromNodePathEntry[])
      : null,
    // Not a stored column: the source run's root is resolved on demand by the archive read path
    // (createRunArchive.tree, #257), the only reader that needs it. A bare row read leaves it null.
    reused_from_root_run_id: null,
  };
  return fromWireRunRecord(wire);
}

/**
 * One run row by its own id, or undefined when no row has it. Resume uses it to resolve a reuse row's
 * `reusedFromRunId` to the source record — whose real row lives in an ancestor tree, still in this
 * global table — so a chained resume reads the reused blob and stamps its new marker direct-to-source
 * (#257, ADR 0001). Undefined when the ancestor tree was since `rm`'d — the caller reads that as "no
 * recorded data to reuse", exactly as the cost query treats `rootRunIdOf`.
 */
export function getRun(db: Database.Database, runId: string): RunRecord | undefined {
  const row = db.prepare(`SELECT * FROM runs WHERE run_id = @runId`).get({ runId }) as RunRowDb | undefined;
  return row ? fromDbRow(row) : undefined;
}

export function getRunsForRoot(db: Database.Database, rootRunId: string): RunRecord[] {
  const rows = db
    .prepare(`SELECT * FROM runs WHERE root_run_id = @rootRunId ORDER BY started_at`)
    .all({ rootRunId }) as RunRowDb[];
  return rows.map(fromDbRow);
}

/**
 * The frozen **launch worker-default** table a run recorded on its own root row (#519, ADR 0044), or
 * `undefined` when the run supplied none — or when no row has that id. The operator's launch table is
 * identity-defining like `input` and never re-overridable, so `Project.resume`/`complete` restore it
 * from here rather than taking one off the request: a re-run step then resolves through the same
 * `node.worker → launch → file → type` order the launch did, with the file tier live. It is
 * engine-internal, so it rides this accessor rather than `RunRecord`/the wire.
 */
export function getLaunchWorkerDefaults(db: Database.Database, rootRunId: string): { [stepType: string]: string } | undefined {
  const row = db
    .prepare(`SELECT launch_worker_defaults FROM runs WHERE run_id = @rootRunId`)
    .get({ rootRunId }) as { launch_worker_defaults: string | null } | undefined;
  if (!row || row.launch_worker_defaults === null) return undefined;
  return JSON.parse(row.launch_worker_defaults) as { [stepType: string]: string };
}

/**
 * The root run id of the tree a run belongs to, or `null` when no row has that id. Used by the
 * cost-SUM (#176) to reach a reuse-marker's `original_run_id` back to its tree so the marker's
 * whole recorded subtree can be summed — a marker may name a leaf or a collapsed workflow-run, and
 * either resolves through the row's own `root_run_id`. `null` when the original tree has since been
 * `rm`'d, which the caller reads as "no recorded data to reach", not an error.
 */
export function rootRunIdOf(db: Database.Database, runId: string): string | null {
  const row = db.prepare(`SELECT root_run_id FROM runs WHERE run_id = @runId`).get({ runId }) as
    | { root_run_id: string }
    | undefined;
  return row ? row.root_run_id : null;
}

export interface ListRootRunsOptions {
  /** Cap on the number of root runs returned; server-api-v0.md §3 default. */
  limit?: number;
  /** Optional filter: return only root runs in this status. */
  status?: RunStatus;
  /** Optional filter (#202): only root runs whose source workflow has this human `name` (exact). */
  workflowName?: string;
  /** Optional filter (#202): only root runs whose source workflow has this GUID `id` (exact). */
  workflowId?: string;
}

/**
 * Lists root runs — the rows whose own id is the tree root (`run_id = root_run_id`), one per run
 * tree — most-recent-first (server-api-v0.md §3). `getRunsForRoot` needs a known id and returns a
 * whole tree; this is the complementary "which root runs exist" query. The `rowid DESC` tiebreaker
 * keeps ordering stable when two roots share a `started_at` millisecond.
 */
export function listRootRuns(db: Database.Database, options: ListRootRunsOptions = {}): RunRecord[] {
  const limit = options.limit ?? 50;
  const params: { limit: number; status?: RunStatus; workflowName?: string; workflowId?: string } = { limit };
  let filterClause = "";
  if (options.status !== undefined) {
    filterClause += " AND status = @status";
    params.status = options.status;
  }
  // Root-only columns (#202): a nested row's `workflow_name`/`workflow_id` is always null, and a
  // root row's own id equals its root id — so `run_id = root_run_id` already scopes the filter to
  // roots, and matching a non-null value can never pick up a nested row.
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

/**
 * Which of the given run ids still have a row, as a set. Used to tell a live predecessor from a
 * deleted one when rendering `resumed-from` (#174): a run's `resumedFromRootRunId` names a root that
 * may since have been `runs rm`'d, and existence — not membership of any listing page — is what
 * decides whether it renders live or `(deleted)`. Duplicates and an empty input are handled here so
 * callers can pass the raw column straight through.
 */
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
