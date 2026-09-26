import {
  displayStatusByRun,
  isPassRun,
  type RunNodeState,
  type RunStatus,
} from "@path/client-core";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * The canvas projection (surface 6, ADR 0025): each node's runs folded to one status, keyed by the node's
 * durable `id`. A node with any run executing projects `running`; otherwise the status of its most-recently
 * started run, read through `displayStatusByRun` (ADR 0038). Pass rows and `nodeId: null` root runs project
 * nothing onto the canvas (ADR 0054).
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
    projected.set(nodeId, running ? "running" : (display.get(latest.runId) ?? latest.status));
  }
  return projected;
}

/**
 * Each goto's pass rows in the watched run, keyed by the goto's node id (ADR 0060 §4); a goto that never jumped is
 * absent.
 */
export function projectJumpsSpent(runs: ReadonlyMap<string, RunNodeState>): Map<string, number> {
  const spent = new Map<string, number>();
  for (const run of runs.values()) {
    if (!isPassRun(run) || run.nodeId === null) continue;
    spent.set(run.nodeId, (spent.get(run.nodeId) ?? 0) + 1);
  }
  return spent;
}

/** The run with the greatest `startedAt`; ties keep insertion order. */
function mostRecent(runs: RunNodeState[]): RunNodeState {
  return runs.reduce((best, run) => ((run.startedAt ?? "") >= (best.startedAt ?? "") ? run : best));
}

/** The projection handed to canvas blocks without prop drilling; `null` when no run is watched. */
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
  const projected = useMemo(
    () => (runs ? { status: projectRunStatus(runs), jumpsSpent: projectJumpsSpent(runs) } : null),
    [runs],
  );
  return (
    <RunProjectionContext.Provider value={projected}>{children}</RunProjectionContext.Provider>
  );
}

/** The projected status for one node id, or `null` when nothing is watched or the node has no run yet. */
export function useNodeRunStatus(nodeId: string): RunStatus | null {
  return useContext(RunProjectionContext)?.status.get(nodeId) ?? null;
}

/**
 * The whole status map, for a caller that looks up many node ids in one render (a per-id hook cannot run in a loop).
 */
export function useRunProjection(): ReadonlyMap<string, RunStatus> | null {
  return useContext(RunProjectionContext)?.status ?? null;
}

/** A goto's jumps spent in the watched run (0 when it never jumped), or `null` when nothing is watched. */
export function useGotoJumpsSpent(nodeId: string): number | null {
  const projection = useContext(RunProjectionContext);
  return projection ? (projection.jumpsSpent.get(nodeId) ?? 0) : null;
}
