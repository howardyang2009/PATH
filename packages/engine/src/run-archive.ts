import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonValue, LogEvent, RunRecord, RunStatus } from "@path/schema";
import type Database from "better-sqlite3";
import { getLogEventsForRoot, reuseMarkerReferences } from "./logging/db-backend.js";
import { readNdjsonLog } from "./logging/ndjson-backend.js";
import { dirExists, readJsonBlob, removeDir } from "./persistence/blob-store.js";
import { openDb, SchemaVersionError } from "./persistence/db.js";
import { dbFilePath, RUN_BLOB_FILE, rootRunTreeDir, runBlobDir, runsDir } from "./persistence/paths.js";
import {
  deleteAllRuns,
  deleteRunsForRoot,
  existingRunIds,
  getRunsForRoot,
  listRootRuns,
  rootRunIdOf,
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
   * Which of the given run ids still have rows — the storage fact behind `path runs`' `resumed-from`
   * column (#174), where a predecessor that has been `rm`'d must render `(deleted)` while one merely
   * off the current page renders live. Pagination and existence are different questions, so a
   * listing that has already capped its rows can still ask this about any id.
   */
  existingRunIds(ids: readonly string[]): Set<string>;
  /**
   * One root run's tree, or `null` when no rows exist for this id — the single "is this run known"
   * question every read path asks first.
   */
  tree(rootRunId: string): RunTree | null;
  /**
   * The live successor trees that would be orphaned by deleting `rootRunId` — every *other* root run
   * still holding a reuse-marker whose `original_run_id` points at a run inside this tree (#175). The
   * back-reference is resolved by membership: a marker blocks iff the run it names is one of this
   * tree's own rows, which is the `original_run_id → root-run-id` resolution in its collapsed form
   * (the run belongs to exactly one root). Root run ids only, sorted, deduplicated. A holder whose
   * own rows are already gone (its tree was `rm`'d, leaving orphaned log rows `rm` does not clear) is
   * not live and does not block. `runs rm` refuses by default when this is non-empty and names these
   * in its `--force` output; the archive computes the fact and leaves the policy to the CLI.
   */
  blockingSuccessors(rootRunId: string): string[];
  /**
   * A root run's whole-tree cost as a read-time SUM of `estimated_cost_usd` over its own descendant
   * rows, amended for resume (#176): for every node this tree reused, the SUM also reaches into the
   * *original* tree via the reuse-marker rather than stopping at the successor's own — necessarily
   * absent — row for that node. Without the amendment a resumed tree's total silently undercounts
   * the reused LLM spend the moment any resume has happened.
   *
   * Each reuse-marker's `original_run_id` names where the reused node's real data lives (leaf or a
   * collapsed workflow-run, resolved through that row's own tree), and its whole recorded subtree is
   * summed — costs are leaf-only, so a collapsed subtree contributes exactly its own leaves. Markers
   * fire once per reuse decision over disjoint subtrees, so nothing is double-counted; a marker
   * whose original tree has since been `rm`'d contributes 0, the data being genuinely gone.
   *
   * `0` for an unknown id (no rows, nothing spent) and for a tree with no LLM spend. Regression:
   * with nothing reused there are no markers, so the answer equals a from-scratch run's own SUM.
   */
  cost(rootRunId: string): number;
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
  /** Optional filter (#202): only root runs whose source workflow has this human `name` (exact). */
  workflowName?: string;
  /** Optional filter (#202): only root runs whose source workflow has this GUID `id` (exact). */
  workflowId?: string;
}

/** The blobs a run's directory holds that are readable back through the archive. */
export type RunBlobName = "input" | "output";

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
   * replay an SSE client gets on connect or reconnect (server-api-v0.md §5). `[]` only when *no*
   * log backend recorded this run, which is a run without a persisted narrative, not an error.
   *
   * Either backend of §8.2 can serve it: `run.log` is authoritative when it exists, and the
   * `log_events` table answers when it doesn't. A run configured `log_backends: ["db"]` is a
   * supported configuration, not a degraded one, so its narrative replays like any other.
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

    existingRunIds(ids: readonly string[]): Set<string> {
      return existingRunIds(db, ids);
    },

    tree(rootRunId: string): RunTree | null {
      const runs = getRunsForRoot(db, rootRunId);
      if (runs.length === 0) return null;
      return makeTree(db, dir, rootRunId, runs);
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
      // A holder whose tree was `rm`'d leaves its log rows behind (rm clears `runs`, not `log_events`),
      // so a dead holder can still name this tree — existence in `runs` is what makes it a live block.
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
      // Always, even when the db held nothing: an orphaned directory shouldn't survive a prune
      // just because its rows happened to be gone already.
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
 * The cost recorded under one run in its own tree — that run and every transitive descendant. Given
 * a reuse-marker's `original_run_id` (a leaf, or a workflow-run whose whole subtree the successor
 * collapsed), this sums the real spend the successor reused. `0` when the original tree is gone.
 */
function subtreeCost(db: Database.Database, originalRunId: string): number {
  const originRootRunId = rootRunIdOf(db, originalRunId);
  if (originRootRunId === null) return 0;
  const runs = getRunsForRoot(db, originRootRunId);
  const childrenOf = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (run.parentRunId === null) continue;
    const siblings = childrenOf.get(run.parentRunId) ?? [];
    siblings.push(run);
    childrenOf.set(run.parentRunId, siblings);
  }
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const start = byId.get(originalRunId);
  if (start === undefined) return 0;
  const subtree: RunRecord[] = [];
  const stack: RunRecord[] = [start];
  while (stack.length > 0) {
    const run = stack.pop()!;
    subtree.push(run);
    for (const child of childrenOf.get(run.runId) ?? []) stack.push(child);
  }
  return sumCost(subtree);
}

function makeTree(db: Database.Database, projectDir: string, rootRunId: string, runs: RunRecord[]): RunTree {
  const root = runs.find((run) => run.runId === rootRunId) ?? null;

  function readBlobAt(blobDir: string, name: RunBlobName): JsonValue | undefined {
    const filename = RUN_BLOB_FILE[name];
    if (!existsSync(join(blobDir, filename))) return undefined;
    return readJsonBlob(blobDir, filename);
  }

  function blob(runId: string, name: RunBlobName): JsonValue | undefined {
    const record = runs.find((run) => run.runId === runId);
    if (record === undefined) return undefined;
    // A reuse row (#257) holds no blobs of its own: its input/output live under the source run it
    // reused, in that run's own tree. Follow `reusedFromRunId` there — direct-to-source (ADR 0001) —
    // so the I/O panel shows the reused values rather than nothing. `rootRunIdOf` locates the source
    // tree; a source since `rm`'d resolves to null and reads as "no blob", same as an absent file.
    if (record.reusedFromRunId !== null) {
      const sourceRootRunId = rootRunIdOf(db, record.reusedFromRunId);
      if (sourceRootRunId === null) return undefined;
      return readBlobAt(runBlobDir(projectDir, sourceRootRunId, record.reusedFromRunId), name);
    }
    return readBlobAt(runBlobDir(projectDir, rootRunId, runId), name);
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
      // `run.log` first, `log_events` second. With both backends on (§8.2's default) the two hold
      // the same narrative, so reading the file keeps every replay in the default configuration
      // byte-identical to what it was before the table became readable — including acceptance
      // §5.2, which uses `run.log` on disk as the yardstick the stream must match. The fallback is
      // reached exactly when the ndjson backend was off, where the alternative is `[]`.
      //
      // Emptiness, not the file's existence, is the switch: a run whose `run.log` is still just its
      // header replays from the table rather than from nothing, and a run with neither backend on
      // finds both empty and is genuinely empty.
      const ndjson = readNdjsonLog(projectDir, rootRunId);
      // Already masked at write (`log_events` rows come only from `write`), so no second pass here.
      const events = ndjson.length > 0 ? ndjson : getLogEventsForRoot(db, rootRunId);
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
