import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonValue, LogEvent, RunRecord, RunStatus } from "@path/schema";
import type Database from "better-sqlite3";
import { readNdjsonLog } from "./logging/ndjson-backend.js";
import { dirExists, readJsonBlob, removeDir } from "./persistence/blob-store.js";
import { openDb, SchemaVersionError } from "./persistence/db.js";
import { dbFilePath, rootRunTreeDir, runBlobDir, runsDir } from "./persistence/paths.js";
import {
  deleteAllRuns,
  deleteRunsForRoot,
  getRunsForRoot,
  listRootRuns,
} from "./persistence/run-store.js";

/**
 * What a finished run left behind in `.path/`, read back.
 *
 * **What this module exists to own.** `Project` gave the *write* side of a run an owner (#64): one
 * place that knows `.path/`, opens its db, and assembles a run into it. The read and delete sides
 * had none. Five server routes and two CLI subcommands each composed the same three stores by hand
 * — run rows from `path.db`, blobs under `.path/runs/<root>/<run>/`, the narrative in
 * `<root>/run.log` — so the engine's on-disk layout was a fact every caller had to know, and
 * `Project.db` was public purely to let them.
 *
 * The consequences were the ordinary ones. `rows.find((row) => row.runId === rootRunId)` (the root
 * row of a tree) was written four times; `runBlobDir(dir, root, run) + "output.json"` twice; the
 * blob filenames `input.json`/`output.json` lived in an HTTP route. `path runs rm` bypassed
 * `Project` entirely and carried its own copy of the "which error is the operator's fault" policy.
 * A change to the layout would have had to land in `paths.ts`, `run-store.ts` and six call sites in
 * another package at once, with nothing in the type system saying so.
 *
 * The division of labour matches `Project`'s. An archive knows what is stored and where; it knows
 * nothing about HTTP status codes, exit codes, or which of its `null`s is a 404 — those stay with
 * the server and the CLI.
 */
export interface RunArchive {
  /** Root runs, most recent first (server-api-v0.md §3). */
  listRoots(options?: ListRootsOptions): RunRecord[];
  /**
   * One root run's tree, or `null` when no rows exist for this id — the single "is this run known"
   * question every read path asks first.
   */
  tree(rootRunId: string): RunTree | null;
  /**
   * Removes one root run's rows *and* its on-disk tree, which mvp spec §6 requires happen together
   * so the two stores never drift. `false` when neither store held anything for the id — an
   * orphaned directory with no rows still counts as something to remove, so a half-finished
   * cleanup can be finished rather than reported missing.
   */
  remove(rootRunId: string): boolean;
  /** Removes every run from both stores. Returns the number of rows removed. */
  prune(): number;
}

export interface ListRootsOptions {
  /** Cap on the number of root runs returned; server-api-v0.md §3 default is 50. */
  limit?: number;
  /** Optional filter: only root runs in this status. */
  status?: RunStatus;
}

/** The blobs a run's directory holds that are readable back through the archive. */
export type RunBlobName = "input" | "output";

const BLOB_FILENAME: Record<RunBlobName, string> = {
  input: "input.json",
  output: "output.json",
};

/**
 * One root run's tree as it was persisted: its rows, its blobs, and its narrative, addressed by run
 * id rather than by directory. A `RunTree` is a snapshot — it holds the rows read when it was
 * built, so a caller that needs fresher rows asks the archive for the tree again.
 */
export interface RunTree {
  readonly rootRunId: string;
  /** Every run of the tree in start order (mvp spec §5.7). Never empty. */
  readonly runs: RunRecord[];
  /**
   * The row whose own id is the root id — an invariant of the run tree, and the only row whose
   * status describes the *tree*. `null` when the tree has rows but not that one, which a caller
   * that must not mistake a child's status for the root's has to handle (a child can read
   * `succeeded` while the tree is still running).
   */
  readonly root: RunRecord | null;
  /** Whether a run id belongs to this tree. */
  has(runId: string): boolean;
  /** The root run's output — `undefined` unless it succeeded and recorded an output blob. */
  output(): JsonValue | undefined;
  /**
   * One run's blob, or `undefined` when the run isn't in this tree or the file isn't there.
   * `undefined` rather than `null` because `null` is a value a stored blob can legitimately hold,
   * and "no blob" must not read as "a blob containing null".
   */
  blob(runId: string, name: RunBlobName): JsonValue | undefined;
  /**
   * The persisted Log event narrative in `seq` order, sliced to `seq > afterSeq` when given — the
   * replay an SSE client gets on connect or reconnect (server-api-v0.md §5). `[]` when the `ndjson`
   * backend was never enabled for this run, which is a run without a persisted narrative, not an
   * error.
   */
  events(afterSeq?: number): LogEvent[];
}

/**
 * An archive over an already-open db. Used where the db's lifetime belongs to someone else — the
 * server holds one `Project` per process and the archive rides on its db.
 */
export function createRunArchive(db: Database.Database, projectDir: string): RunArchive {
  const dir = resolve(projectDir);

  return {
    listRoots(options: ListRootsOptions = {}): RunRecord[] {
      return listRootRuns(db, options);
    },

    tree(rootRunId: string): RunTree | null {
      const runs = getRunsForRoot(db, rootRunId);
      if (runs.length === 0) return null;
      return makeTree(dir, rootRunId, runs);
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
      // Always, even when the db held nothing: an orphaned directory shouldn't survive a prune
      // just because its rows happened to be gone already.
      removeDir(runsDir(dir));
      return deleted;
    },
  };
}

function makeTree(projectDir: string, rootRunId: string, runs: RunRecord[]): RunTree {
  const root = runs.find((run) => run.runId === rootRunId) ?? null;

  function blob(runId: string, name: RunBlobName): JsonValue | undefined {
    if (!runs.some((run) => run.runId === runId)) return undefined;
    const blobDir = runBlobDir(projectDir, rootRunId, runId);
    const filename = BLOB_FILENAME[name];
    if (!existsSync(join(blobDir, filename))) return undefined;
    return readJsonBlob(blobDir, filename);
  }

  return {
    rootRunId,
    runs,
    root,
    has: (runId) => runs.some((run) => run.runId === runId),
    // `outputRef` is the row's own record that the blob was written, so a succeeded root without
    // one has no output to read rather than a missing file to explain.
    output: () => (root?.status === "succeeded" && root.outputRef ? blob(root.runId, "output") : undefined),
    blob,
    events(afterSeq?: number): LogEvent[] {
      const events = readNdjsonLog(projectDir, rootRunId);
      return afterSeq === undefined ? events : events.filter((event) => event.seq > afterSeq);
    },
  };
}

export type OpenRunArchiveResult =
  | { success: true; archive: RunArchive; close(): void }
  | { success: false; error: string };

/**
 * Opens a project's archive on its own, for a caller that reads or deletes runs without running
 * one — `path runs rm`/`path runs prune`, which need neither engine settings nor `.path/` to be
 * created for them.
 *
 * A project with no `path.db` yet has no run rows, but may still have an orphaned run tree on disk
 * that `remove`/`prune` must clean up. That case opens an in-memory db with the same schema, so
 * every query below stays unconditional and nothing is written to disk: asking a directory that
 * never ran a workflow about its runs must not leave a db behind.
 */
export function openRunArchive(projectDir: string): OpenRunArchiveResult {
  const dir = resolve(projectDir);
  const dbFile = dbFilePath(dir);

  let db: Database.Database;
  try {
    db = openDb(existsSync(dbFile) ? dbFile : ":memory:");
  } catch (err) {
    const error = err instanceof SchemaVersionError ? err.message : `cannot open .path/path.db: ${String(err)}`;
    return { success: false, error };
  }

  return { success: true, archive: createRunArchive(db, dir), close: () => db.close() };
}
