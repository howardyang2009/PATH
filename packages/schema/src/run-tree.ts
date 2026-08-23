import { isRootRun } from "./run-kind.js";

/**
 * The run tree, as a shared primitive (CONTEXT.md, *run tree*). A workflow-step's run spawns child
 * runs, so the runs of one root form a tree keyed by `parentRunId`. That shape was rebuilt row by row
 * wherever it was needed — the engine's cost SUM walked a subtree, a client view nested the whole
 * tree — each re-deriving the parent→children adjacency. This owns it once, generic over any row that
 * carries a run id and a parent.
 *
 * It stays deliberately low: adjacency and a descendant walk, not a nested render model. A live view's
 * concerns (sort order, a nested node type) sit on top of `childrenByParent`; the engine's subtree sum
 * sits on top of `subtree`. Root detection is `isRootRun` (run-kind.ts), the one place that reads it.
 */

/** The two fields the tree shape is read from — a `RunRecord` or a client `RunNodeState` fits. */
export interface RunTreeFields {
  runId: string;
  parentRunId: string | null;
}

/**
 * Group non-root rows by their `parentRunId`. `orphanTo` handles a live, incomplete stream: a row
 * whose parent is not among `rows` (its parent row has not arrived yet) is filed under `orphanTo`
 * instead of a key nothing walks, so a root-down walk still reaches it rather than dropping it. A
 * complete persisted tree omits `orphanTo` — every non-root parent is present, so nothing is orphaned.
 */
export function childrenByParent<T extends RunTreeFields>(
  rows: Iterable<T>,
  options: { orphanTo?: string } = {},
): Map<string, T[]> {
  const rowArray = [...rows];
  const ids = new Set(rowArray.map((row) => row.runId));
  const byParent = new Map<string, T[]>();
  for (const row of rowArray) {
    // A root has no parent to file it under (`isRootRun`); the `=== null` form is what narrows
    // `parentRunId` to a string for the rest of the loop.
    if (row.parentRunId === null) continue;
    let parent = row.parentRunId;
    if (options.orphanTo !== undefined && !ids.has(parent)) parent = options.orphanTo;
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(row);
    else byParent.set(parent, [row]);
  }
  return byParent;
}

/**
 * The rows of the subtree rooted at `startId` — `startId`'s own row and every transitive descendant,
 * flat. `[]` when no row has `startId`. Every row has one parent, so the walk terminates: a cycle
 * among parents (which no engine-produced tree contains) is unreachable from `startId` rather than
 * infinite.
 */
export function subtree<T extends RunTreeFields>(rows: Iterable<T>, startId: string): T[] {
  const rowArray = [...rows];
  const byParent = childrenByParent(rowArray);
  const start = rowArray.find((row) => row.runId === startId);
  if (start === undefined) return [];
  const out: T[] = [];
  const stack: T[] = [start];
  while (stack.length > 0) {
    const row = stack.pop()!;
    out.push(row);
    for (const child of byParent.get(row.runId) ?? []) stack.push(child);
  }
  return out;
}

/** The tree's root row — the one with no parent (invariant 2) — or `undefined` when it is absent. */
export function findRootRun<T extends { parentRunId: string | null }>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    if (isRootRun(row)) return row;
  }
  return undefined;
}
