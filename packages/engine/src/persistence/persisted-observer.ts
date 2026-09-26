import { randomUUID } from "node:crypto";
import type { JsonValue, LaunchFacts, RerunFromNodePathEntry } from "@path/schema";
import type Database from "better-sqlite3";
import type { RunObserver, RunOutcome } from "../run-observer.js";
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
 * §6). One instance serves an entire run tree, since every observation carries its own `rootRunId`; the
 * blob lands first and the row carries its ref from the start, so the two can never point at different files. */
export function createPersistedObserver(db: Database.Database, projectDir: string): RunObserver {
  /** A run began. `seedsContext` distinguishes the two callers: a workflow-run's input seeds its context
   * (format §6.3) and writes `context.json` alongside `input.json`; a leaf step's input does not. */
  function recordStarted(
    fact: {
      runId: string;
      rootRunId: string;
      parentRunId: string | null;
      nodeId: string | null;
      nodeName: string | null;
      workerName: string | null;
      input: JsonValue;
      // Present only on a `while-do` iteration container's run-started (ADR 0037); 1-based ordinal.
      iteration?: number;
      // Present only on a goto pass container's run-started (ADR 0054); 1-based ordinal.
      pass?: number;
      // Present only on a resumed tree's root run-started; the row records it verbatim.
      resumedFromRootRunId?: string;
      // Present only on a Resume-from-K successor's root run-started (ADR 0032): the boundary (K) descent path.
      rerunFromNodePath?: RerunFromNodePathEntry[];
      // Present only on a launch root run-started that supplied one (ADR 0046): the operator's frozen launch facts.
      launchFacts?: LaunchFacts;
      // Present only on the root run-started: the source-workflow identity trio, recorded verbatim.
      workflowId?: string;
      workflowName?: string;
      workflowPath?: string;
    },
    seedsContext: boolean,
  ): void {
    const {
      runId,
      rootRunId,
      parentRunId,
      nodeId,
      nodeName,
      workerName,
      iteration,
      pass,
      input,
      resumedFromRootRunId,
      rerunFromNodePath,
      launchFacts,
    } = fact;
    const inputRef = writeRunBlob(projectDir, rootRunId, runId, RUN_BLOB_FILE.input, input);
    if (seedsContext) writeRunBlob(projectDir, rootRunId, runId, RUN_BLOB_FILE.context, input);
    insertRun(db, {
      runId,
      rootRunId,
      parentRunId,
      nodeId,
      nodeName,
      workerName,
      iteration,
      pass,
      status: "running",
      inputRef,
      resumedFromRootRunId,
      rerunFromNodePath,
      launchFacts,
      workflowId: fact.workflowId,
      workflowName: fact.workflowName,
      workflowPath: fact.workflowPath,
    });
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
          // Root run: parentRunId/nodeId/workerName null. Nested workflow-run: its parent run's id and the
          // `workflow` node's id, with no worker of its own (ADR 0021 sub-14). Its input seeds the context
          // (format §6.3), unlike a leaf step's; a goto pass container shares it and writes no snapshot.
          recordStarted({ ...o, workerName: null }, o.pass === undefined);
          return;

        case "step-started":
          recordStarted(o, false);
          return;

        // Always written, even empty — captured for audit, never passed downstream (format §4). Not a JSON
        // blob and not referenced by a row column, so it goes through the raw writer.
        case "step-stderr":
          writeBlobFile(
            runBlobDir(projectDir, o.rootRunId, o.runId),
            RUN_BLOB_FILE.stderr,
            o.stderr,
          );
          return;

        // Leaf-only (mvp spec §5.7): the row where the tokens were actually spent.
        case "step-usage":
          setRunUsage(db, o.runId, { usage: o.usage, estimatedCostUsd: o.estimatedCostUsd });
          return;

        // Context write-through (mvp spec §6): rewritten atomically on every mutation.
        case "context-changed":
          writeRunBlob(projectDir, o.rootRunId, o.runId, RUN_BLOB_FILE.context, o.context);
          return;

        // A per-step context snapshot: the same `context.json`, but under the leaf step's own run directory
        // (`o.runId` is the step run), so the input/output pair gains a context companion as it stood at finish.
        case "step-context":
          writeRunBlob(projectDir, o.rootRunId, o.runId, RUN_BLOB_FILE.context, o.context);
          return;

        case "step-awaiting":
          setRunStatus(db, o.runId, "awaiting");
          return;

        case "step-finished":
        case "run-finished":
          recordFinished(o.rootRunId, o.runId, o);
          return;

        // A reused node records a real `succeeded` reuse row, so it appears in the run tree and a chained
        // resume can reuse it from `runs`. It holds no blobs and no spend — `reused_from_run_id` points at
        // the source run (direct-to-source, ADR 0001) — while the `reuse-marker` event stays the cost/rm record.
        case "reuse-marker":
          insertReuseRun(db, {
            runId: randomUUID(),
            rootRunId: o.rootRunId,
            parentRunId: o.runId,
            nodeId: o.nodeId,
            nodeName: o.nodeName,
            reusedFromRunId: o.originalRunId,
          });
          return;

        // Control-node observations have no run of their own (invariant 1), so there is no row to write: they
        // are narrative, and the log stream is where they live. `run-cancelled` included — the cancelled row is
        // written by the paired step-finished.
        case "join-applied":
        case "run-cancelled":
        case "checkpoint-evaluated":
        case "branch-taken":
        case "branch-no-match":
        case "iteration-started":
        case "loop-exited":
        case "pass-started":
        case "goto-taken":
        case "goto-exhausted":
          return;

        default: {
          const exhaustive: never = o;
          return exhaustive;
        }
      }
    },
  };
}
