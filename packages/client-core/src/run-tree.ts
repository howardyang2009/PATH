import { childrenByParent, type RunStatus } from "@path/schema";
import type { RunNodeState } from "./view-model.js";

/**
 * One run and the runs it spawned, nested. A workflow-step's run spawns child runs (CONTEXT.md,
 * *workflow-as-step*), so what nests here is the **run tree**, not the workflow body: every node is
 * a run, and `children` is in execution order.
 */
export interface RunTreeNode {
  run: RunNodeState;
  /** The status every surface shows for this run — see {@link displayStatusByRun}. */
  displayStatus: RunStatus;
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
  const display = displayStatusByRun(runs);
  const nest = (run: RunNodeState): RunTreeNode => ({
    run,
    displayStatus: display.get(run.runId) ?? run.status,
    children: (byParent.get(run.runId) ?? []).map(nest),
  });
  return nest(root);
}

/**
 * The status each run should **display**, keyed by run id: its record status, except that a `running`
 * run with an `awaiting` run anywhere below it reads `awaiting`. This is the **one** status derivation
 * the read surfaces share — the runs list, the run-detail head, the run tree, and the node I/O head —
 * so a root whose leaf is parked reads `awaiting` the same way in every pane.
 *
 * It is **view-only** and touches no status. The root and every intermediate workflow-run stay
 * `running` in the record while a leaf awaits (ADR 0038) — that is the engine's truth and the DB's.
 * This only repaints the pill, so a pending completion below is visible without expanding the tree.
 *
 * Computed once per snapshot rather than once per row, so a deep tree costs one walk, not one walk per
 * row. A run already `awaiting`, terminal, or `pending` keeps its own status — only a `running`
 * ancestor is ever repainted, and the walk up from a parked run stops at the first ancestor that is
 * not `running` (a finished run has no live descendant). A caller with no descendants loaded passes a
 * map that holds only the run itself, and gets its record status back unchanged.
 */
export function displayStatusByRun(runs: ReadonlyMap<string, RunNodeState>): Map<string, RunStatus> {
  const display = new Map<string, RunStatus>();
  for (const run of runs.values()) display.set(run.runId, run.status);

  for (const run of runs.values()) {
    if (run.status !== "awaiting") continue;
    // Walk up from the parked run: its still-`running` ancestors read `awaiting` too. A run whose
    // parent the map does not hold (the stream ran ahead of the last tree read) cannot repaint an
    // ancestor it cannot name. The seen-set keeps a hand-built cycle from looping; an engine-built
    // tree cannot hold one (every run has exactly one parent).
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
