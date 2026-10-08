import { isRootRun } from "./run-kind.js";
import type { RunStatus } from "./run-status.js";

/** The run tree as a shared primitive (CONTEXT.md, *run tree*): the runs of one root, keyed by
 * `parentRunId`. Deliberately low — adjacency and a descendant walk, not a nested render model. */

/** The two fields the tree shape is read from — a `RunRecord` or a client `RunNodeState` fits. */
export interface RunTreeFields {
  runId: string;
  parentRunId: string | null;
}

/** Group non-root rows by their `parentRunId`. `orphanTo` handles a live, incomplete stream: a row
 * whose parent has not arrived, or that came off an event with no parent yet, is filed there
 * instead of a key nothing walks, so a root-down walk still reaches it. */
export function childrenByParent<T extends RunTreeFields>(
  rows: Iterable<T>,
  options: { orphanTo?: string } = {},
): Map<string, T[]> {
  const rowArray = [...rows];
  const ids = new Set(rowArray.map((row) => row.runId));
  const byParent = new Map<string, T[]>();
  for (const row of rowArray) {
    const { orphanTo } = options;
    let parent = row.parentRunId;
    if (orphanTo !== undefined && row.runId !== orphanTo && (parent === null || !ids.has(parent)))
      parent = orphanTo;
    // A root has no parent to file under.
    if (parent === null) continue;
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(row);
    else byParent.set(parent, [row]);
  }
  return byParent;
}

/**
 * The rows of the subtree rooted at `startId`, flat; `[]` when no row has it. Every row has one
 * parent, so the walk terminates — a parent cycle is unreachable from `startId`.
 */
export function subtree<T extends RunTreeFields>(rows: Iterable<T>, startId: string): T[] {
  const rowArray = [...rows];
  const byParent = childrenByParent(rowArray);
  const start = rowArray.find((row) => row.runId === startId);
  if (start === undefined) return [];
  const out: T[] = [];
  const stack: T[] = [start];
  for (let row = stack.pop(); row !== undefined; row = stack.pop()) {
    out.push(row);
    for (const child of byParent.get(row.runId) ?? []) stack.push(child);
  }
  return out;
}

/** The tree's root row — the one with no parent (invariant 2) — or `undefined` when it is
 * absent. */
export function findRootRun<T extends { parentRunId: string | null }>(
  rows: Iterable<T>,
): T | undefined {
  for (const row of rows) {
    if (isRootRun(row)) return row;
  }
  return undefined;
}

/** The ancestor path root→…→`startId`, top-down and inclusive, walking `parentRunId` up — the
 * complement of `subtree`; `[]` when absent, and an incomplete stream stops at the highest
 * reachable ancestor. */
export function pathToRoot<T extends RunTreeFields>(rows: Iterable<T>, startId: string): T[] {
  const byId = new Map([...rows].map((row) => [row.runId, row] as const));
  const start = byId.get(startId);
  if (start === undefined) return [];
  const chain: T[] = [];
  let cursor: T | undefined = start;
  while (cursor !== undefined) {
    chain.unshift(cursor);
    if (cursor.parentRunId === null) break;
    cursor = byId.get(cursor.parentRunId);
  }
  return chain;
}

/** The status each run should display: its record status, except a `running` run with an `awaiting`
 * run below it reads `awaiting` (view-only, ADR 0038); one walk per snapshot. */
export function displayStatusByRun<T extends RunTreeFields & { status: RunStatus }>(
  rows: Iterable<T> | ReadonlyMap<string, T>,
): Map<string, RunStatus> {
  const runs = new Map<string, T>();
  for (const row of "values" in rows ? rows.values() : rows) runs.set(row.runId, row);
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
