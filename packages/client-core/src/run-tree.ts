import type { RunNodeState } from "./view-model.js";

/**
 * One run and the runs it spawned, nested. A workflow-step's run spawns child runs (CONTEXT.md,
 * *workflow-as-step*), so what nests here is the **run tree**, not the workflow body: every node is
 * a run, and `children` is in execution order.
 */
export interface RunTreeNode {
  run: RunNodeState;
  children: RunTreeNode[];
}

/**
 * Builds the run tree a view renders from the flat run map a `RunViewState` holds. `null` when the
 * root run itself is not in the map — there is nothing to render yet, which a view says in its own
 * words.
 *
 * **Why this is core and not view.** Three facts about runs decide the shape, and none of them is a
 * rendering choice:
 *
 * - **Parentage.** A run's parent is the run that spawned it.
 * - **Orphans hang off the root.** A run may name a parent the map does not (yet) contain — the
 *   event stream runs ahead of the last tree read — so it attaches to the root until a re-read
 *   places it, rather than vanishing from the tree mid-run.
 * - **Order is execution order.** Oldest start first; a run that has not started yet sorts last,
 *   with the run id breaking ties so the order is stable between two renders of the same data.
 *
 * A second consumer reaching different answers would be showing a different run tree, not a
 * differently styled one.
 */
export function buildRunTree(rootRunId: string, runs: ReadonlyMap<string, RunNodeState>): RunTreeNode | null {
  const root = runs.get(rootRunId);
  if (!root) return null;

  const childrenByParent = new Map<string, RunNodeState[]>();
  for (const run of runs.values()) {
    if (run.runId === rootRunId) continue;
    const parent = run.parentRunId !== null && runs.has(run.parentRunId) ? run.parentRunId : rootRunId;
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(run);
    else childrenByParent.set(parent, [run]);
  }
  for (const siblings of childrenByParent.values()) siblings.sort(byStartOrder);

  // Every run has exactly one parent, so this is a forest and the walk down from the root
  // terminates: a run can be reached by at most one path, and a cycle among parents (which no
  // engine-produced tree contains) is unreachable from the root rather than infinite.
  const nest = (run: RunNodeState): RunTreeNode => ({
    run,
    children: (childrenByParent.get(run.runId) ?? []).map(nest),
  });
  return nest(root);
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
