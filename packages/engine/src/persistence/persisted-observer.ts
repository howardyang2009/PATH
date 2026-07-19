import type Database from "better-sqlite3";
import type { RunObserver, RunOutcome } from "../run-observer.js";
import { writeBlobFile, writeJsonBlob } from "./blob-store.js";
import { blobRef, runBlobDir } from "./paths.js";
import { finishRun, insertRun, setRunBlobRefs } from "./run-store.js";

/**
 * A `RunObserver` (see run-observer.ts) that persists every run row and blob under `.path/`
 * (mvp spec §5.7, §6). One instance is scoped to a single root run (there is no nested-workflow
 * execution yet — #22 — so every step in scope here belongs to the one root run captured from
 * `runStarted`).
 */
export function createPersistedObserver(db: Database.Database, projectDir: string): RunObserver {
  // null until runStarted fires; every other hook requires it, so a null read is a genuine
  // contract violation (a hook firing out of order) rather than a state to silently tolerate.
  let rootRunId: string | null = null;

  function requireRootRunId(): string {
    if (rootRunId === null) {
      throw new Error("RunObserver hook fired before runStarted — no root run id to persist under");
    }
    return rootRunId;
  }

  // stepFinished and runFinished share this exact shape: mark the row done, and only a
  // successful outcome has a real output to persist (mvp spec §5.7 — output_ref is per-row).
  function finishAndPersistOutput(root: string, runId: string, outcome: RunOutcome): void {
    finishRun(db, runId, outcome.status);
    if (outcome.status === "succeeded") {
      const dir = runBlobDir(projectDir, root, runId);
      writeJsonBlob(dir, "output.json", outcome.output);
      setRunBlobRefs(db, runId, { outputRef: blobRef(root, runId, "output.json") });
    }
  }

  return {
    runStarted({ runId, input }) {
      rootRunId = runId;
      insertRun(db, { runId, rootRunId, parentRunId: null, nodeId: null, worker: null, status: "running" });
      const dir = runBlobDir(projectDir, rootRunId, runId);
      writeJsonBlob(dir, "input.json", input);
      writeJsonBlob(dir, "context.json", input); // format doc §6.3: workflow input seeds context
      setRunBlobRefs(db, runId, { inputRef: blobRef(rootRunId, runId, "input.json") });
    },

    stepStarted({ runId, parentRunId, nodeId, worker, input }) {
      const root = requireRootRunId();
      insertRun(db, { runId, rootRunId: root, parentRunId, nodeId, worker, status: "running" });
      const dir = runBlobDir(projectDir, root, runId);
      writeJsonBlob(dir, "input.json", input);
      setRunBlobRefs(db, runId, { inputRef: blobRef(root, runId, "input.json") });
    },

    stepStderr({ runId, stderr }) {
      // Always written, even empty — stderr is captured for audit, never passed downstream
      // (format doc §4.2); secret-scrubbing it is #20's scope.
      writeBlobFile(runBlobDir(projectDir, requireRootRunId(), runId), "stderr.txt", stderr);
    },

    stepFinished(info) {
      finishAndPersistOutput(requireRootRunId(), info.runId, info);
    },

    contextChanged({ runId, context }) {
      // Context write-through (mvp spec §6): rewritten atomically on every mutation, so
      // on-disk state always matches the live blackboard, even if the engine is later killed.
      writeJsonBlob(runBlobDir(projectDir, requireRootRunId(), runId), "context.json", context);
    },

    runFinished(info) {
      finishAndPersistOutput(requireRootRunId(), info.runId, info);
    },
  };
}
