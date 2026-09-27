import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  type RunObserver,
  type RunPayload,
  type UnsequencedLogEvent,
  WORKFLOW_STEP_TYPE,
} from "../run-observer.js";
import { writeBlobFile, writeRunBlob } from "./blob-store.js";
import { RUN_BLOB_FILE, runBlobDir } from "./paths.js";
import {
  finishRun,
  insertReuseRun,
  insertRun,
  setRunOutputRef,
  setRunStatus,
  setRunUsage,
} from "./run-store.js";

/**
 * A `RunObserver` (see run-observer.ts) that records every run row and blob under `.path/` (mvp spec §5.7,
 * §6). One instance serves an entire run tree, since every event carries its own `rootRunId`; the blob
 * lands first and the row carries its ref from the start, so the two can never point at different files. */
export function createPersistedObserver(db: Database.Database, projectDir: string): RunObserver {
  /** A run began: a workflow-run (`step_type` `workflow`, no worker of its own, ADR 0021 sub-14) or a leaf step.
   * A workflow-run's input also seeds its context (format §6.3), except a goto pass container's, which shares it. */
  function recordStarted(
    runId: string,
    rootRunId: string,
    event: UnsequencedLogEvent | null,
    started: Extract<RunPayload, { kind: "started" }>,
  ): void {
    if (event?.type !== "step-started")
      throw new Error("a started payload rides a step-started event");
    const isWorkflowRun = event.step_type === WORKFLOW_STEP_TYPE;
    const inputRef = writeRunBlob(projectDir, rootRunId, runId, RUN_BLOB_FILE.input, started.input);
    if (isWorkflowRun && started.pass === undefined)
      writeRunBlob(projectDir, rootRunId, runId, RUN_BLOB_FILE.context, started.input);
    insertRun(db, {
      runId,
      rootRunId,
      parentRunId: started.parentRunId,
      nodeId: event.node_id,
      nodeName: event.node_name,
      workerName: isWorkflowRun ? null : event.worker_name,
      iteration: started.iteration,
      pass: started.pass,
      status: "running",
      inputRef,
      resumedFromRootRunId: started.resumedFromRootRunId,
      rerunFromNodePath: started.rerunFromNodePath,
      launchFacts: started.launchFacts,
      workflowId: started.workflowId,
      workflowName: started.workflowName,
      workflowPath: started.workflowPath,
    });
  }

  return {
    observe({ runId, rootRunId, event, payload }) {
      switch (payload?.kind) {
        case "started":
          recordStarted(runId, rootRunId, event, payload);
          return;
        // Always written, even empty — captured for audit, never passed downstream (format §4). Not a JSON
        // blob and not referenced by a row column, so it goes through the raw writer.
        case "stderr":
          writeBlobFile(
            runBlobDir(projectDir, rootRunId, runId),
            RUN_BLOB_FILE.stderr,
            payload.stderr,
          );
          return;
        // Leaf-only (mvp spec §5.7): the row where the tokens were actually spent.
        case "usage":
          setRunUsage(db, runId, {
            usage: payload.usage,
            estimatedCostUsd: payload.estimatedCostUsd,
          });
          return;
        // Context write-through (mvp spec §6), rewritten on every mutation; for a leaf step run the same
        // `context.json` lands under its own directory as the context stood at its finish.
        case "context":
          writeRunBlob(projectDir, rootRunId, runId, RUN_BLOB_FILE.context, payload.context);
          return;
      }

      switch (event?.type) {
        case "step-awaiting":
          setRunStatus(db, runId, "awaiting");
          return;
        // Only a successful finish has an output to persist (mvp spec §5.7).
        case "step-finished":
          finishRun(db, runId, event.status);
          if (payload?.kind === "output") {
            const ref = writeRunBlob(
              projectDir,
              rootRunId,
              runId,
              RUN_BLOB_FILE.output,
              payload.output,
            );
            setRunOutputRef(db, runId, ref);
          }
          return;
        // A reused node records a real `succeeded` reuse row, so it appears in the run tree and a chained
        // resume can reuse it from `runs`. It holds no blobs and no spend — `reused_from_run_id` points at
        // the source run (direct-to-source, ADR 0001) — while the `reuse-marker` event stays the cost/rm record.
        case "reuse-marker":
          insertReuseRun(db, {
            runId: randomUUID(),
            rootRunId,
            parentRunId: runId,
            nodeId: event.node_id!,
            nodeName: event.node_name,
            reusedFromRunId: event.original_run_id,
          });
          return;
        // Control-node events have no run of their own (invariant 1), so no row to write: the log is where
        // they live. `run-cancelled` included — the paired step-finished writes the cancelled row.
        default:
          return;
      }
    },
  };
}
