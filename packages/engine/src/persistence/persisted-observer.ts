import type { JsonValue, Worker } from "@path/schema";
import type Database from "better-sqlite3";
import type { RunObserver, RunOutcome } from "../run-observer.js";
import { writeBlobFile, writeRunBlob } from "./blob-store.js";
import { RUN_BLOB_FILE, runBlobDir } from "./paths.js";
import { finishRun, insertRun, setRunOutputRef, setRunUsage } from "./run-store.js";

/**
 * A `RunObserver` (see run-observer.ts) that records every run row and blob under `.path/`
 * (mvp spec §5.7, §6). One instance serves an entire run tree: every observation carries its own
 * `rootRunId`, so a nested workflow-run (#22) records under the same root as its parent without the
 * observer holding any per-run state. The run tree in the db (parent/root ids on each row) and on
 * disk (`.path/runs/<root>/<run>/`) mirror the nesting, and each workflow-run keeps its own isolated
 * `context.json`.
 *
 * This module answers both halves of one question — which observations are run facts, and how a run
 * fact lands in `.path/`. They used to be two modules with a `RunStore` interface between them, but
 * that interface was three one-line delegations and a parameter object built by patching fields into
 * an observation at the caller: neither side could be read without the other's vocabulary.
 *
 * Recording one run used to take four calls in a required order — insert the row, build the blob
 * directory, write the blob, then update the row with a ref built separately from the same pieces.
 * Two hazards came with that (#72). The directory (`runBlobDir`, host separators) and the ref
 * (`blobRef`, always forward slashes) had to address the same file with nothing checking, so a
 * mismatch left the blob on disk and the row pointing elsewhere: no error, no failing test, just a
 * run whose input is unreadable through the API. And every row was INSERTed then immediately
 * UPDATEd, because `insertRun` did not take the ref its caller already had. Both are gone by
 * construction: `writeRunBlob` returns the ref for the bytes it just wrote, and the row carries that
 * ref from the start.
 *
 * Reads stay free functions in `run-store.ts` — `getRunsForRoot` and `listRootRuns` are queries with
 * no order between them, and the archive imports them directly. It is the write side that has a
 * sequence, so it is the write side that has an owner.
 */
export function createPersistedObserver(db: Database.Database, projectDir: string): RunObserver {
  /**
   * A run began. `seedsContext` distinguishes the two callers: a workflow-run's input seeds its
   * context (format §6.3), so `context.json` is written alongside `input.json`; a leaf step's input
   * does not. The blob lands first and the row carries its ref from the start (#72).
   */
  function recordStarted(
    fact: {
      runId: string;
      rootRunId: string;
      parentRunId: string | null;
      nodeId: string | null;
      worker: Worker | null;
      input: JsonValue;
    },
    seedsContext: boolean,
  ): void {
    const { runId, rootRunId, parentRunId, nodeId, worker, input } = fact;
    const inputRef = writeRunBlob(projectDir, rootRunId, runId, RUN_BLOB_FILE.input, input);
    if (seedsContext) writeRunBlob(projectDir, rootRunId, runId, RUN_BLOB_FILE.context, input);
    insertRun(db, { runId, rootRunId, parentRunId, nodeId, worker, status: "running", inputRef });
  }

  /** A run ended. Only a successful outcome has an output to persist (mvp spec §5.7). */
  function recordFinished(rootRunId: string, runId: string, outcome: RunOutcome): void {
    finishRun(db, runId, outcome.status);
    if (outcome.status === "succeeded") {
      const ref = writeRunBlob(projectDir, rootRunId, runId, RUN_BLOB_FILE.output, outcome.output);
      setRunOutputRef(db, runId, ref);
    }
  }

  return {
    observe(o) {
      switch (o.type) {
        case "run-started":
          // Root run: parentRunId/nodeId null, worker null. Nested workflow-run (#22): its parent
          // run's id + the `workflow` node's id — workflow-as-step means this row *is* that step.
          // A workflow-run's input seeds its context (format doc §6.3), which a leaf step's does not.
          recordStarted({ ...o, worker: null }, true);
          return;

        case "step-started":
          recordStarted(o, false);
          return;

        // Always written, even empty — captured for audit, never passed downstream (format §4.2).
        // Not a JSON blob and not referenced by a row column, so it goes through the raw writer.
        case "step-stderr":
          writeBlobFile(runBlobDir(projectDir, o.rootRunId, o.runId), RUN_BLOB_FILE.stderr, o.stderr);
          return;

        // Leaf-only (mvp spec §5.7): the row where the tokens were actually spent.
        case "step-usage":
          setRunUsage(db, o.runId, { usage: o.usage, estimatedCostUsd: o.estimatedCostUsd });
          return;

        // Context write-through (mvp spec §6): rewritten atomically on every mutation.
        case "context-changed":
          writeRunBlob(projectDir, o.rootRunId, o.runId, RUN_BLOB_FILE.context, o.context);
          return;

        case "step-finished":
        case "run-finished":
          recordFinished(o.rootRunId, o.runId, o);
          return;

        // Control-node observations have no run of their own (invariant 1), so there is no row to
        // write: they are narrative, and the log stream is where they live. `run-cancelled` included
        // — the cancelled row is written by the `cancelled` step-finished paired with it.
        case "join-applied":
        case "run-cancelled":
        case "checkpoint-evaluated":
        case "branch-taken":
        case "branch-no-match":
        case "iteration-started":
        case "loop-exited":
          return;

        default: {
          const exhaustive: never = o;
          return exhaustive;
        }
      }
    },
  };
}
