import { createContext, useContext, useMemo, type ReactNode } from "react";
import { displayStatusByRun, isPassRun, type RunNodeState, type RunStatus } from "@path/client-core";

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
 *
 * Each run is read through `displayStatusByRun` (ADR 0038), the one derivation every run surface
 * shares: a `workflow` step's run is the nested run's root, so it stays `running` in the record while
 * a leaf in the sub-workflow parks. The projection repaints that node `awaiting` — the same status the
 * run tree, the runs list and the breadcrumb show — instead of masking it with the record's `running`.
 *
 * A goto **pass** row (ADR 0054) carries the `nodeId` of the goto that opened it, but a goto runs for no
 * time, so the fold skips pass rows and a goto block takes no status, like a `branch` (#620). The steps a
 * pass ran are its children and carry their own `nodeId`, so a step revisited in several passes projects
 * its latest run, as a `while-do` body does.
 */
export function projectRunStatus(runs: ReadonlyMap<string, RunNodeState>): Map<string, RunStatus> {
  const display = displayStatusByRun(runs);
  const byNode = new Map<string, RunNodeState[]>();
  for (const run of runs.values()) {
    if (run.nodeId === null || isPassRun(run)) continue;
    const group = byNode.get(run.nodeId) ?? [];
    group.push(run);
    byNode.set(run.nodeId, group);
  }

  const projected = new Map<string, RunStatus>();
  for (const [nodeId, group] of byNode) {
    const running = group.find((run) => display.get(run.runId) === "running");
    const latest = mostRecent(group);
    projected.set(nodeId, running ? "running" : display.get(latest.runId) ?? latest.status);
  }
  return projected;
}

/**
 * Each goto's jumps spent in the watched run, keyed by the goto's node id: the count of pass rows it
 * opened (ADR 0060 §4). Pass 1 has no opener (`nodeId` null), so it counts for no goto. A goto that never
 * jumped is absent.
 */
export function projectJumpsSpent(runs: ReadonlyMap<string, RunNodeState>): Map<string, number> {
  const spent = new Map<string, number>();
  for (const run of runs.values()) {
    if (!isPassRun(run) || run.nodeId === null) continue;
    spent.set(run.nodeId, (spent.get(run.nodeId) ?? 0) + 1);
  }
  return spent;
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
interface RunProjection {
  status: ReadonlyMap<string, RunStatus>;
  jumpsSpent: ReadonlyMap<string, number>;
}

const RunProjectionContext = createContext<RunProjection | null>(null);

export function RunProjectionProvider({
  runs,
  children,
}: {
  runs: ReadonlyMap<string, RunNodeState> | null;
  children: ReactNode;
}): JSX.Element {
  const projected = useMemo(() => (runs ? { status: projectRunStatus(runs), jumpsSpent: projectJumpsSpent(runs) } : null), [runs]);
  return <RunProjectionContext.Provider value={projected}>{children}</RunProjectionContext.Provider>;
}

/** The projected status for one node id, or `null` when nothing is being watched or the node has no run yet. */
export function useNodeRunStatus(nodeId: string): RunStatus | null {
  return useContext(RunProjectionContext)?.status.get(nodeId) ?? null;
}

/**
 * The whole projection map, or `null` when nothing is watched. For a caller that looks up **many** node ids
 * in one render — the breadcrumb, one badge per descent crumb — where a per-id hook cannot run in a loop.
 */
export function useRunProjection(): ReadonlyMap<string, RunStatus> | null {
  return useContext(RunProjectionContext)?.status ?? null;
}

/** A goto's jumps spent in the watched run (0 when it never jumped), or `null` when nothing is watched. */
export function useGotoJumpsSpent(nodeId: string): number | null {
  const projection = useContext(RunProjectionContext);
  return projection ? projection.jumpsSpent.get(nodeId) ?? 0 : null;
}
