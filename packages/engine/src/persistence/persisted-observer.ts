import type Database from "better-sqlite3";
import type { RunObserver } from "../run-observer.js";
import { createRunStore } from "./run-store-writer.js";

/**
 * A `RunObserver` (see run-observer.ts) that records every run row and blob under `.path/`
 * (mvp spec §5.7, §6). One instance serves an entire run tree: every observation carries its own
 * `rootRunId`, so a nested workflow-run (#22) records under the same root as its parent without the
 * observer holding any per-run state. The run tree in the db (parent/root ids on each row) and on
 * disk (`.path/runs/<root>/<run>/`) mirror the nesting, and each workflow-run keeps its own isolated
 * `context.json`.
 *
 * All this file does is decide which observations are run facts and which are narrative. How a fact
 * is stored — rows, blob paths, refs, and the order they must land in — belongs to the store (#72).
 */
export function createPersistedObserver(db: Database.Database, projectDir: string): RunObserver {
  const store = createRunStore(db, projectDir);

  return {
    observe(o) {
      switch (o.type) {
        case "run-started":
          // Root run: parentRunId/nodeId null, worker null. Nested workflow-run (#22): its parent
          // run's id + the `workflow` node's id — workflow-as-step means this row *is* that step.
          // A workflow-run's input seeds its context (format doc §6.3), which a leaf step's does not.
          store.runStarted({ ...o, worker: null, seedsContext: true });
          return;

        case "step-started":
          store.runStarted({ ...o, seedsContext: false });
          return;

        case "step-stderr":
          store.stderrCaptured(o.rootRunId, o.runId, o.stderr);
          return;

        case "step-usage":
          store.usageRecorded(o.runId, o.usage, o.estimatedCostUsd);
          return;

        case "context-changed":
          store.contextChanged(o.rootRunId, o.runId, o.context);
          return;

        case "step-finished":
        case "run-finished":
          store.runFinished(o.rootRunId, o.runId, o);
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
