import type { JsonValue, Worker } from "@path/schema";
import type Database from "better-sqlite3";
import type { RunOutcome } from "../run-observer.js";
import { writeBlobFile, writeRunBlob } from "./blob-store.js";
import { runBlobDir } from "./paths.js";
import { finishRun, insertRun, setRunOutputRef, setRunUsage } from "./run-store.js";

/**
 * The write side of `.path/`, stated as **run facts** rather than SQL verbs (#72).
 *
 * Recording one run used to take four calls in a required order — insert the row, build the blob
 * directory, write the blob, then update the row with a ref built separately from the same pieces —
 * and that sequence was written out three times. Two hazards came with it. The directory
 * (`runBlobDir`, host separators) and the ref (`blobRef`, always forward slashes) had to address the
 * same file with nothing checking, so a mismatch left the blob on disk and the row pointing
 * elsewhere: no error, no failing test, just a run whose input is unreadable through the API. And
 * every row was INSERTed then immediately UPDATEd, because `insertRun` did not take the ref its
 * caller already had.
 *
 * Both are gone by construction: `writeRunBlob` returns the ref for the bytes it just wrote, and the
 * row carries that ref from the start.
 *
 * Reads stay free functions in `run-store.ts` — `getRunsForRoot` and `listRootRuns` are queries with
 * no order between them, and the server imports them directly. It is the write side that has a
 * sequence, so it is the write side that gets an owner.
 */
export interface RunStore {
  /**
   * A run began. `seedsContext` distinguishes the two callers: a workflow-run's input seeds its
   * context (format §6.3), so `context.json` is written alongside `input.json`; a leaf step's input
   * does not.
   */
  runStarted(fact: {
    runId: string;
    rootRunId: string;
    parentRunId: string | null;
    nodeId: string | null;
    worker: Worker | null;
    input: JsonValue;
    seedsContext: boolean;
  }): void;
  /** A run ended. Only a successful outcome has an output to persist (mvp spec §5.7). */
  runFinished(rootRunId: string, runId: string, outcome: RunOutcome): void;
  /** Leaf-only (mvp spec §5.7): the row where the tokens were actually spent. */
  usageRecorded(runId: string, usage: JsonValue | null, estimatedCostUsd: number | null): void;
  /** Always written, even empty — captured for audit, never passed downstream (format §4.2). */
  stderrCaptured(rootRunId: string, runId: string, stderr: string): void;
  /** Context write-through (mvp spec §6): rewritten atomically on every mutation. */
  contextChanged(rootRunId: string, runId: string, context: JsonValue): void;
}

export function createRunStore(db: Database.Database, projectDir: string): RunStore {
  return {
    runStarted({ runId, rootRunId, parentRunId, nodeId, worker, input, seedsContext }) {
      const inputRef = writeRunBlob(projectDir, rootRunId, runId, "input.json", input);
      if (seedsContext) writeRunBlob(projectDir, rootRunId, runId, "context.json", input);
      insertRun(db, { runId, rootRunId, parentRunId, nodeId, worker, status: "running", inputRef });
    },

    runFinished(rootRunId, runId, outcome) {
      finishRun(db, runId, outcome.status);
      if (outcome.status === "succeeded") {
        setRunOutputRef(db, runId, writeRunBlob(projectDir, rootRunId, runId, "output.json", outcome.output));
      }
    },

    usageRecorded(runId, usage, estimatedCostUsd) {
      setRunUsage(db, runId, { usage, estimatedCostUsd });
    },

    stderrCaptured(rootRunId, runId, stderr) {
      // Not a JSON blob and not referenced by a row column, so it goes through the raw writer.
      writeBlobFile(runBlobDir(projectDir, rootRunId, runId), "stderr.txt", stderr);
    },

    contextChanged(rootRunId, runId, context) {
      writeRunBlob(projectDir, rootRunId, runId, "context.json", context);
    },
  };
}
