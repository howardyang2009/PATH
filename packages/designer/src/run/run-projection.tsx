import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { RunNodeState, RunStatus } from "@path/client-core";

/**
 * The canvas projection (surface 6, ADR 0025): live run status folded onto the workflow's nodes. One
 * node produces **many runs** — a `while-do` iterates, a `parallel` fans out, a resume writes a reuse
 * row — so a node's projected status is a fold of all its runs, not a single row. The map is keyed by a
 * node's durable `id` (`RunNodeState.nodeId`, ADR 0015), which is exactly the canvas node's own `id`, so
 * a canvas block looks itself up by id.
 *
 * The fold answers "where in my workflow is it": a node with **any run still executing** projects
 * `running` (that is what the author is watching for); otherwise it projects the status of its
 * **most-recently started** run (a while-do shows its latest iteration's verdict, not an early one's).
 * Only `running` short-circuits — a `pending` (queued) row must not mask a newer terminal verdict, so
 * it is left to the recency fallback. Runs with no `nodeId` — the implicit root run — project onto
 * nothing on the canvas; they live in the inspector tree.
 */
export function projectRunStatus(runs: ReadonlyMap<string, RunNodeState>): Map<string, RunStatus> {
  const byNode = new Map<string, RunNodeState[]>();
  for (const run of runs.values()) {
    if (run.nodeId === null) continue;
    const group = byNode.get(run.nodeId) ?? [];
    group.push(run);
    byNode.set(run.nodeId, group);
  }

  const projected = new Map<string, RunStatus>();
  for (const [nodeId, group] of byNode) {
    const running = group.find((run) => run.status === "running");
    projected.set(nodeId, running ? running.status : mostRecent(group).status);
  }
  return projected;
}

/** The run with the greatest `startedAt`; a never-started run sorts earliest, and ties keep insertion order. */
function mostRecent(runs: RunNodeState[]): RunNodeState {
  return runs.reduce((best, run) => ((run.startedAt ?? "") >= (best.startedAt ?? "") ? run : best));
}

/**
 * The projection made available to the canvas blocks without threading a prop through every block shape
 * (mirroring how `SelectionProvider` reaches the same tree). `null` when no run is being watched — the
 * canvas then draws no run tint at all.
 */
const RunProjectionContext = createContext<ReadonlyMap<string, RunStatus> | null>(null);

export function RunProjectionProvider({
  runs,
  children,
}: {
  runs: ReadonlyMap<string, RunNodeState> | null;
  children: ReactNode;
}): JSX.Element {
  const projected = useMemo(() => (runs ? projectRunStatus(runs) : null), [runs]);
  return <RunProjectionContext.Provider value={projected}>{children}</RunProjectionContext.Provider>;
}

/** The projected status for one node id, or `null` when nothing is being watched or the node has no run yet. */
export function useNodeRunStatus(nodeId: string): RunStatus | null {
  return useContext(RunProjectionContext)?.get(nodeId) ?? null;
}
