import { childrenByParent, type RunStatus } from "@path/schema";
import type { RunNodeState } from "./view-model.js";

/** One run and the runs it spawned, nested; `children` is in execution order. */
export interface RunTreeNode {
  run: RunNodeState;
  /** The status every surface shows for this run — see {@link displayStatusByRun}. */
  displayStatus: RunStatus;
  children: RunTreeNode[];
}

/** Build the run tree a view renders from the flat run map; `null` when the root run is absent.
 * A run naming a parent the map lacks attaches to the root; children are in execution order. */
export function buildRunTree(
  rootRunId: string,
  runs: ReadonlyMap<string, RunNodeState>,
): RunTreeNode | null {
  const root = runs.get(rootRunId);
  if (!root) return null;

  // An orphan waits at the root — the event stream can run ahead of the last tree read (`orphanTo`).
  const byParent = childrenByParent(runs.values(), { orphanTo: rootRunId });
  for (const siblings of byParent.values()) siblings.sort(byStartOrder);

  // Every run has exactly one parent, so the walk down from the root terminates.
  const display = displayStatusByRun(runs);
  const nest = (run: RunNodeState): RunTreeNode => ({
    run,
    displayStatus: display.get(run.runId) ?? run.status,
    children: (byParent.get(run.runId) ?? []).map(nest),
  });
  return nest(root);
}

/** The status each run should display: its record status, except a `running` run with an `awaiting`
 * run below it reads `awaiting` (view-only, ADR 0038); one walk per snapshot. */
export function displayStatusByRun(
  runs: ReadonlyMap<string, RunNodeState>,
): Map<string, RunStatus> {
  const display = new Map<string, RunStatus>();
  for (const run of runs.values()) display.set(run.runId, run.status);

  for (const run of runs.values()) {
    if (run.status !== "awaiting") continue;
    // Walk up from the parked run: its still-`running` ancestors read `awaiting` too.
    const seen = new Set<string>([run.runId]);
    let parentId = run.parentRunId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = runs.get(parentId);
      if (parent === undefined || parent.status !== "running") break;
      display.set(parentId, "awaiting");
      parentId = parent.parentRunId;
    }
  }
  return display;
}

/** Oldest start first; a run that has not started yet sorts last. Run id breaks ties. */
function byStartOrder(a: RunNodeState, b: RunNodeState): number {
  if (a.startedAt !== b.startedAt) {
    if (a.startedAt === null) return 1;
    if (b.startedAt === null) return -1;
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}
