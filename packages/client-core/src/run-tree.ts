import { childrenByParent, type RunStatus } from "@path/schema";
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

  // A run whose parent the map does not (yet) hold attaches to the root — the event stream runs
  // ahead of the last tree read, so an orphan waits at the root rather than vanishing (`orphanTo`).
  const byParent = childrenByParent(runs.values(), { orphanTo: rootRunId });
  for (const siblings of byParent.values()) siblings.sort(byStartOrder);

  // Every run has exactly one parent, so this is a forest and the walk down from the root
  // terminates: a run can be reached by at most one path, and a cycle among parents (which no
  // engine-produced tree contains) is unreachable from the root rather than infinite.
  const nest = (run: RunNodeState): RunTreeNode => ({
    run,
    children: (byParent.get(run.runId) ?? []).map(nest),
  });
  return nest(root);
}

/**
 * The status a run should **display**, which is its record status except that a `running` run with an
 * `awaiting` run anywhere in its subtree displays `awaiting`. This is the **one** status derivation the
 * four read surfaces share — the runs list, the run-detail head, the run tree, and the node I/O head —
 * so a root whose leaf is parked reads `awaiting` the same way in every pane.
 *
 * It is **view-only** and touches no status. The root and every intermediate workflow-run stay
 * `running` in the record while a leaf awaits (ADR 0038) — that is the engine's truth and the DB's.
 * This only repaints the pill, so a pending completion below is visible without expanding the tree.
 *
 * `runs` is the run map of the tree the run lives in; a caller that has no descendants loaded (the runs
 * list holds only summaries for the runs it is not watching) passes an empty map and gets the record
 * status back unchanged. A run already `awaiting`, or terminal, or `pending` returns its own status —
 * only a `running` run is ever repainted.
 */
export function effectiveRunStatus(run: { runId: string; status: RunStatus }, runs: ReadonlyMap<string, RunNodeState>): RunStatus {
  if (run.status !== "running") return run.status;
  return subtreeHasAwaiting(run.runId, runs) ? "awaiting" : "running";
}

/** Whether any transitive descendant of `rootId` in `runs` is `awaiting` (the run itself excluded). */
function subtreeHasAwaiting(rootId: string, runs: ReadonlyMap<string, RunNodeState>): boolean {
  const byParent = new Map<string, RunNodeState[]>();
  for (const run of runs.values()) {
    if (run.parentRunId === null) continue;
    const siblings = byParent.get(run.parentRunId);
    if (siblings) siblings.push(run);
    else byParent.set(run.parentRunId, [run]);
  }
  // Iterative DFS from the run's own children so a deep tree cannot overflow the stack.
  const stack = [...(byParent.get(rootId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.status === "awaiting") return true;
    // A cycle only hand-built data can hold (every engine run has one parent) must not loop forever.
    if (seen.has(node.runId)) continue;
    seen.add(node.runId);
    const children = byParent.get(node.runId);
    if (children) stack.push(...children);
  }
  return false;
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
