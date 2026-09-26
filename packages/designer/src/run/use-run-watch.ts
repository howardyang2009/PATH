import type { PathApiClient } from "@path/client-core";
import { useRunView } from "@path/viewer";
import { useEffect, useRef, useState } from "react";

/** The Designer's run-watching state: one `useRunView` connection feeds both the canvas projection and the
 * inspector; a new root run drops the in-tree selection, since an id from the previous tree names nothing. */
export function useRunWatch(client: PathApiClient, rootWorkflowId: string | null) {
  const [rootRunId, setRootRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Bumped to make the run list re-read now, not at the next periodic tick.
  const [reloadNonce, setReloadNonce] = useState(0);

  // A new root workflow names none of the watched run's ids, so drop the watch — otherwise the run-detail pane
  // and breadcrumb badge the new workflow with the old run. Keyed on the root id, so a descent leaves it be.
  const prevRootWorkflowId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevRootWorkflowId.current;
    prevRootWorkflowId.current = rootWorkflowId;
    if (prev !== undefined && prev !== rootWorkflowId) {
      setRootRunId(null);
      setSelectedRunId(null);
    }
  }, [rootWorkflowId]);

  const load = useRunView(client, rootRunId);
  // The root run has no `nodeId`, so it projects onto no canvas node; the App badges the breadcrumb with it.
  const runsForProjection = load.phase === "ready" ? load.value.runs : null;
  // The breadcrumb badge reads the root's **display** status (`displayStatusByRun`, ADR 0038); the raw status
  // is the fallback before the root's row lands in the map.
  const workflowRunStatus =
    load.phase === "ready" && rootRunId !== null
      ? (load.value.displayStatus.get(rootRunId) ?? load.value.status)
      : null;

  const selectRootRun = (id: string): void => {
    setRootRunId(id);
    setSelectedRunId(null);
  };

  // A launch/resume is a click's transition plus a nudge so the list shows the new row now.
  const watchNewRun = (id: string): void => {
    selectRootRun(id);
    setReloadNonce((nonce) => nonce + 1);
  };

  // A delete drops the watched run if it was the one removed, then nudges the list — the mirror of a launch.
  const onDeleted = (id: string): void => {
    if (id === rootRunId) {
      setRootRunId(null);
      setSelectedRunId(null);
    }
    setReloadNonce((nonce) => nonce + 1);
  };

  return {
    load,
    runsForProjection,
    workflowRunStatus,
    rootRunId,
    selectedRunId,
    reloadNonce,
    selectRootRun,
    selectRun: setSelectedRunId,
    watchNewRun,
    onDeleted,
  };
}
