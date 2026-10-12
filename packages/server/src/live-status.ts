import {
  displayStatusByRun,
  isTerminal,
  type LogEvent,
  type RunRecord,
  type RunStatus,
} from "@path/schema";

interface StatusRow {
  runId: string;
  parentRunId: string | null;
  status: RunStatus;
}

/**
 * The display status per run (ADR 0038) over the stored rows with a live run's unstored events
 * folded in. A sandboxed tree's rows reach the store only when its VM exits, so without the events
 * every surface would show the tree as it stood before the VM started.
 */
export function liveDisplayStatus(
  rows: readonly RunRecord[],
  unstored: readonly LogEvent[],
): Map<string, RunStatus> {
  if (unstored.length === 0) return displayStatusByRun(rows);
  const runs = new Map<string, StatusRow>(
    rows.map(({ runId, parentRunId, status }) => [runId, { runId, parentRunId, status }]),
  );
  for (const event of unstored) {
    const run = runs.get(event.run_id);
    switch (event.type) {
      case "step-started":
        if (run === undefined && event.parent_run_id !== undefined) {
          const parentRunId = event.parent_run_id;
          runs.set(event.run_id, { runId: event.run_id, parentRunId, status: "running" });
        } else if (run !== undefined && !isTerminal(run.status)) run.status = "running";
        break;
      case "step-awaiting":
        if (run !== undefined && !isTerminal(run.status)) run.status = "awaiting";
        break;
      case "step-finished":
        if (run !== undefined) run.status = event.status;
        break;
      case "reuse-marker":
        if (event.reuse_run_id !== undefined && !runs.has(event.reuse_run_id)) {
          const runId = event.reuse_run_id;
          runs.set(runId, { runId, parentRunId: event.run_id, status: "succeeded" });
        }
        break;
    }
  }
  return displayStatusByRun(runs);
}
