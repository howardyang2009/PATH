import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findRootRun,
  isReuseRow,
  type JsonValue,
  type LaunchFacts,
  type LogEvent,
  type RunRecord,
  type RunStatus,
  subtree,
} from "@path/schema";
import type Database from "better-sqlite3";
import { reuseMarkerReferences } from "./logging/db-backend.js";
import { openRunLog } from "./logging/run-log.js";
import { dirExists, readJsonBlob, removeDir } from "./persistence/blob-store.js";
import { openDb, SchemaVersionError } from "./persistence/db.js";
import {
  blobRef,
  dbFilePath,
  RUN_BLOB_FILE,
  rootRunTreeDir,
  runBlobDir,
  runsDir,
} from "./persistence/paths.js";
import {
  deleteAllRuns,
  deleteRunsForRoot,
  existingRunIds,
  getLaunchFacts,
  getRunsForRoot,
  listRootRuns,
  rootRunIdOf,
} from "./persistence/run-store.js";

/**
 * Read/delete side of a run's `.path/` footprint. An archive knows what is stored and where, and
 * nothing about HTTP status codes, exit codes, or which of its `null`s a caller reads as a 404 —
 * those stay with the server and the CLI.
 */
export interface RunArchive {
  /** Root runs, most recent first (server-api-v0.md §3). */
  listRoots(options?: ListRootsOptions): RunRecord[];
  /** Which of the given run ids still have rows; pagination and existence are separate questions. */
  existingRunIds(ids: readonly string[]): Set<string>;
  /** One root run's tree, or `null` when no rows exist for this id. */
  tree(rootRunId: string): RunTree | null;
  /**
   * The tree's root run id for a run, or `null` when no row has that id — a leaf names its root so a Complete route
   * can recover the root's recorded workflow path (ADR 0041).
   */
  rootRunIdOf(runId: string): string | null;
  /**
   * The launch facts the tree's root row recorded (ADR 0046): input override, masked config override, launch
   * worker-default table and secret config paths; `undefined` when nothing was supplied.
   */
  launchFacts(rootRunId: string): LaunchFacts | undefined;
  /**
   * Live successor trees that deleting this root would orphan — other roots holding a reuse-marker naming a run
   * inside it. Root ids only, sorted; a holder whose own rows are gone does not block.
   */
  blockingSuccessors(rootRunId: string): string[];
  /**
   * A root run's whole-tree cost: a read-time SUM of `estimated_cost_usd` over its descendant rows,
   * amended for resume by also summing each reuse-marker's original subtree — without which a resumed
   * tree silently undercounts reused LLM spend. `0` for an unknown id or a tree with no spend.
   */
  cost(rootRunId: string): number;
  /**
   * Removes one root run's rows *and* its on-disk tree together (mvp spec §6) so the stores never drift; `false` only
   * when neither held anything.
   */
  remove(rootRunId: string): boolean;
  /** Removes every run from both stores. Returns the number of rows removed. */
  prune(): number;
}

export interface ListRootsOptions {
  /** Cap on the number of root runs returned; server-api-v0.md §3 default is 50. */
  limit?: number;
  status?: RunStatus;
  /** Only root runs whose source workflow has this human `name` (exact). */
  workflowName?: string;
  workflowId?: string;
}

/**
 * Blobs a run's directory holds; only a workflow-run writes a `context.json`, so a leaf step's `context` read is
 * `undefined` like any absent file.
 */
export type RunBlobName = "input" | "output" | "context";

/**
 * One root run's tree as persisted — rows, blobs and narrative by run id. A snapshot; ask the archive again for
 * fresher rows.
 */
export interface RunTree {
  readonly rootRunId: string;
  /** Every run of the tree in start order (mvp spec §5.7). Never empty. */
  readonly runs: RunRecord[];
  /**
   * The row whose own id is the root id — the only row whose status describes the *tree*; `null` when the tree has
   * rows but not that one.
   */
  readonly root: RunRecord | null;
  /** Whether a run id belongs to this tree. */
  has(runId: string): boolean;
  /** The root run's output — `undefined` unless it succeeded and recorded an output blob. */
  output(): JsonValue | undefined;
  /**
   * One run's blob, or `undefined` when the run isn't in this tree or the file isn't there; `undefined` not `null`
   * because a stored blob can legitimately hold `null`.
   */
  blob(runId: string, name: RunBlobName): JsonValue | undefined;
  /**
   * The persisted Log narrative in `seq` order, sliced to `seq > afterSeq` — the SSE replay on connect
   * (server-api-v0.md §5). `[]` only when no log backend recorded the run; either §8.2 backend serves it.
   */
  events(afterSeq?: number): LogEvent[];
}

/** An archive over an already-open db, used where the db's lifetime belongs to someone else. */
export function createRunArchive(db: Database.Database, projectDir: string): RunArchive {
  const dir = resolve(projectDir);

  return {
    listRoots(options: ListRootsOptions = {}): RunRecord[] {
      return listRootRuns(db, options);
    },

    existingRunIds(ids: readonly string[]): Set<string> {
      return existingRunIds(db, ids);
    },

    tree(rootRunId: string): RunTree | null {
      const runs = getRunsForRoot(db, rootRunId);
      if (runs.length === 0) return null;
      // Resolve each reuse row's provenance once, so every downstream reader sees a record that no longer lies about
      // what it has.
      return makeTree(
        db,
        dir,
        rootRunId,
        runs.map((run) => resolveReuseRow(db, run)),
      );
    },

    rootRunIdOf(runId: string): string | null {
      return rootRunIdOf(db, runId);
    },

    launchFacts(rootRunId: string): LaunchFacts | undefined {
      return getLaunchFacts(db, rootRunId);
    },

    blockingSuccessors(rootRunId: string): string[] {
      const targetRunIds = new Set(getRunsForRoot(db, rootRunId).map((run) => run.runId));
      if (targetRunIds.size === 0) return [];
      const holders = new Set(
        reuseMarkerReferences(db)
          .filter((ref) => ref.holderRootRunId !== rootRunId && targetRunIds.has(ref.originalRunId))
          .map((ref) => ref.holderRootRunId),
      );
      if (holders.size === 0) return [];
      // `rm` clears `runs` but not `log_events`, so a dead holder can still name this tree; existence in `runs` is
      // what makes it live.
      const live = existingRunIds(db, [...holders]);
      return [...holders].filter((id) => live.has(id)).sort();
    },

    cost(rootRunId: string): number {
      const runs = getRunsForRoot(db, rootRunId);
      if (runs.length === 0) return 0;
      let total = sumCost(runs);
      for (const ref of reuseMarkerReferences(db)) {
        if (ref.holderRootRunId === rootRunId) total += subtreeCost(db, ref.originalRunId);
      }
      return total;
    },

    remove(rootRunId: string): boolean {
      const treeDir = rootRunTreeDir(dir, rootRunId);
      const dirExisted = dirExists(treeDir);
      const deleted = deleteRunsForRoot(db, rootRunId);
      removeDir(treeDir);
      return deleted > 0 || dirExisted;
    },

    prune(): number {
      const deleted = deleteAllRuns(db);
      // Always, even when the db held nothing: an orphaned directory must not survive a prune.
      removeDir(runsDir(dir));
      return deleted;
    },
  };
}

/** SUM of `estimated_cost_usd` over the given rows, a null (a non-LLM or non-leaf row) counting 0. */
function sumCost(runs: readonly RunRecord[]): number {
  return runs.reduce((total, run) => total + (run.estimatedCostUsd ?? 0), 0);
}

/**
 * The cost recorded under one run in its own tree — that run and every transitive descendant; `0` when the original
 * tree is gone.
 */
function subtreeCost(db: Database.Database, originalRunId: string): number {
  const originRootRunId = rootRunIdOf(db, originalRunId);
  if (originRootRunId === null) return 0;
  // The original tree is complete, so no `orphanTo` is needed; a partly-`rm`'d original yields `[]`.
  return sumCost(subtree(getRunsForRoot(db, originRootRunId), originalRunId));
}

/**
 * A reuse row owns no blobs and no source-tree root: its input/output live under the source run it
 * reused, in that run's own tree (direct-to-source, ADR 0001). Resolve that provenance once so
 * `tree()`, `blob()` and the wire read a record that no longer lies about what it has.
 */
function resolveReuseRow(db: Database.Database, run: RunRecord): RunRecord {
  if (!isReuseRow(run)) return run;
  const sourceRootRunId = rootRunIdOf(db, run.reusedFromRunId);
  if (sourceRootRunId === null) return { ...run, reusedFromRootRunId: null };
  return {
    ...run,
    reusedFromRootRunId: sourceRootRunId,
    inputRef: blobRef(sourceRootRunId, run.reusedFromRunId, RUN_BLOB_FILE.input),
    outputRef: blobRef(sourceRootRunId, run.reusedFromRunId, RUN_BLOB_FILE.output),
  };
}

function makeTree(
  db: Database.Database,
  projectDir: string,
  rootRunId: string,
  runs: RunRecord[],
): RunTree {
  const root = findRootRun(runs) ?? null;

  function readBlobAt(blobDir: string, name: RunBlobName): JsonValue | undefined {
    const filename = RUN_BLOB_FILE[name];
    if (!existsSync(join(blobDir, filename))) return undefined;
    return readJsonBlob(blobDir, filename);
  }

  function blob(runId: string, name: RunBlobName): JsonValue | undefined {
    const record = runs.find((run) => run.runId === runId);
    if (record === undefined) return undefined;
    // A reuse row holds no blobs of its own: they live under the source run it reused; the record is already
    // resolved, so read the source off it.
    if (isReuseRow(record)) {
      if (record.reusedFromRootRunId === null) return undefined;
      return readBlobAt(
        runBlobDir(projectDir, record.reusedFromRootRunId, record.reusedFromRunId),
        name,
      );
    }
    return readBlobAt(runBlobDir(projectDir, rootRunId, runId), name);
  }

  return {
    rootRunId,
    runs,
    root,
    has: (runId) => runs.some((run) => run.runId === runId),
    // `outputRef` is the row's own record that the blob was written, so a succeeded root without one has no output to
    // read.
    output: () =>
      root?.status === "succeeded" && root.outputRef ? blob(root.runId, "output") : undefined,
    blob,
    events(afterSeq?: number): LogEvent[] {
      // One owner for where a run's narrative goes (`logging/run-log.ts`), the same rule the Complete path reads.
      const log = openRunLog(projectDir, db, rootRunId);
      return afterSeq === undefined ? log.events() : log.read(afterSeq);
    },
  };
}

export type OpenRunArchiveResult =
  | { success: true; archive: RunArchive; close(): void }
  | { success: false; error: string };

/**
 * Opens a project's archive on its own; a project with no `path.db` yet still opens an in-memory db with the same
 * schema, so an orphaned run tree can be cleaned up without writing anything to disk.
 */
export function openRunArchive(projectDir: string): OpenRunArchiveResult {
  const dir = resolve(projectDir);
  const dbFile = dbFilePath(dir);

  let db: Database.Database;
  try {
    db = openDb(existsSync(dbFile) ? dbFile : ":memory:");
  } catch (err) {
    const error =
      err instanceof SchemaVersionError ? err.message : `cannot open .path/path.db: ${String(err)}`;
    return { success: false, error };
  }

  return { success: true, archive: createRunArchive(db, dir), close: () => db.close() };
}
