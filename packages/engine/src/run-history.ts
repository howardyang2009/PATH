import { isReuseRow, type JsonValue, type RunRecord } from "@path/schema";
import type Database from "better-sqlite3";
import { readJsonBlob } from "./persistence/blob-store.js";
import { runBlobDir } from "./persistence/paths.js";
import { getRun } from "./persistence/run-store.js";

/**
 * The **run history** a continuation sees: the rows of the tree it resumes against, plus a way to
 * read one run's blob. It is the one handle a Resume or a Complete carries, and the seam the
 * predecessor's storage varies across — the project's own `.path` store is its adapter, an
 * in-memory row set with a stub reader is the fake a test builds.
 *
 * A **reuse row** is resolved when the history is built, never at read time: {@link diskRunHistory}
 * swaps it for the source record it points at, so the rows a plan matches already name the run that
 * holds the data (ADR 0001's direct-to-source rule).
 */
export interface RunHistory {
  /** The tree's rows, reuse rows already swapped for their sources. */
  readonly rows: readonly RunRecord[];
  /** One run's blob, addressed by the record's own `rootRunId`, so a reused row reads the source
   * tree. */
  blob(run: RunRecord, filename: string): JsonValue;
}

/**
 * A history over an in-memory row set and a caller's blob reader. The rows are taken as given: the
 * caller has already swapped any reuse row, or built rows that never were reuse rows.
 */
export function runHistory(
  rows: readonly RunRecord[],
  blob: (run: RunRecord, filename: string) => JsonValue,
): RunHistory {
  return { rows, blob };
}

/**
 * A history over an open store: every reuse row in `rows` is swapped for the source record it
 * points at, keeping the reuse row's own `parentRunId`. A source whose tree was since `rm`'d is
 * dropped, so that node re-executes.
 */
export function diskRunHistory(
  db: Database.Database,
  projectDir: string,
  rows: readonly RunRecord[],
): RunHistory {
  return runHistory(
    rows.flatMap((row) => {
      if (!isReuseRow(row)) return [row];
      const source = getRun(db, row.reusedFromRunId);
      return source ? [{ ...source, parentRunId: row.parentRunId }] : [];
    }),
    (run, filename) => readJsonBlob(runBlobDir(projectDir, run.rootRunId, run.runId), filename),
  );
}
