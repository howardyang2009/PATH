import type Database from "better-sqlite3";
import type { RunObserver, RunOutcome } from "../run-observer.js";
import { writeBlobFile, writeJsonBlob } from "./blob-store.js";
import { blobRef, runBlobDir } from "./paths.js";
import { finishRun, insertRun, setRunBlobRefs, setRunUsage } from "./run-store.js";

/**
 * A `RunObserver` (see run-observer.ts) that persists every run row and blob under `.path/`
 * (mvp spec §5.7, §6). One instance serves an entire run tree: every hook carries its own
 * `rootRunId`, so a nested workflow-run (#22) records under the same root as its parent without
 * the observer holding any per-run state. The run tree in the db (parent/root ids on each row)
 * and on disk (`.path/runs/<root>/<run>/`) mirror the nesting, and each workflow-run keeps its
 * own isolated `context.json`.
 */
export function createPersistedObserver(db: Database.Database, projectDir: string): RunObserver {
  // stepFinished and runFinished share this exact shape: mark the row done, and only a
  // successful outcome has a real output to persist (mvp spec §5.7 — output_ref is per-row).
  function finishAndPersistOutput(rootRunId: string, runId: string, outcome: RunOutcome): void {
    finishRun(db, runId, outcome.status);
    if (outcome.status === "succeeded") {
      const dir = runBlobDir(projectDir, rootRunId, runId);
      writeJsonBlob(dir, "output.json", outcome.output);
      setRunBlobRefs(db, runId, { outputRef: blobRef(rootRunId, runId, "output.json") });
    }
  }

  return {
    runStarted({ runId, rootRunId, parentRunId, nodeId, input }) {
      // Root run: parentRunId/nodeId null, worker null. Nested workflow-run (#22): its parent
      // run's id + the `workflow` node's id — workflow-as-step means this row *is* that step.
      insertRun(db, { runId, rootRunId, parentRunId, nodeId, worker: null, status: "running" });
      const dir = runBlobDir(projectDir, rootRunId, runId);
      writeJsonBlob(dir, "input.json", input);
      writeJsonBlob(dir, "context.json", input); // format doc §6.3: workflow input seeds context
      setRunBlobRefs(db, runId, { inputRef: blobRef(rootRunId, runId, "input.json") });
    },

    stepStarted({ runId, rootRunId, parentRunId, nodeId, worker, input }) {
      insertRun(db, { runId, rootRunId, parentRunId, nodeId, worker, status: "running" });
      const dir = runBlobDir(projectDir, rootRunId, runId);
      writeJsonBlob(dir, "input.json", input);
      setRunBlobRefs(db, runId, { inputRef: blobRef(rootRunId, runId, "input.json") });
    },

    stepStderr({ runId, rootRunId, stderr }) {
      // Always written, even empty — stderr is captured for audit, never passed downstream
      // (format doc §4.2); secret-scrubbing it is #20's scope.
      writeBlobFile(runBlobDir(projectDir, rootRunId, runId), "stderr.txt", stderr);
    },

    stepUsage({ runId, usage, estimatedCostUsd }) {
      // Leaf-only (mvp spec §5.7): this row is where the tokens were actually spent; no ancestor
      // row stores a derived total — subtree figures are a read-time SUM over descendants, left to
      // whatever reads the run tree back rather than computed or stored here.
      setRunUsage(db, runId, { usage, estimatedCostUsd });
    },

    stepFinished(info) {
      finishAndPersistOutput(info.rootRunId, info.runId, info);
    },

    contextChanged({ runId, rootRunId, context }) {
      // Context write-through (mvp spec §6): rewritten atomically on every mutation, so
      // on-disk state always matches the live blackboard, even if the engine is later killed.
      // Keyed by the run's own id — each workflow-run has its own context.json (#22).
      writeJsonBlob(runBlobDir(projectDir, rootRunId, runId), "context.json", context);
    },

    runFinished(info) {
      finishAndPersistOutput(info.rootRunId, info.runId, info);
    },
  };
}
