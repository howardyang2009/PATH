import type { PathApiClient } from "@path/client-core";
import { useWatchedRun } from "@path/viewer";

/** The Designer's run-watching state: one watched run (`watched-run.ts`, shared with the Viewer)
 * feeds the run dock, the canvas projection and the breadcrumb badge. */
export function useRunWatch(client: PathApiClient, rootWorkflowId: string | null) {
  // The open workflow is the selection's scope: a new root workflow names none of the watched run's
  // ids, so the selection re-bases — otherwise the run-detail pane and breadcrumb badge the new
  // workflow with the old run. Keyed on the root id, so a descent leaves it be.
  const watch = useWatchedRun(client, rootWorkflowId);
  const { load, selection } = watch;
  // The root run has no `nodeId`, so it projects onto no canvas node; the App badges the breadcrumb
  // with it.
  const projectionView = load.phase === "ready" ? load.value : null;
  // The breadcrumb badge reads the root's **display** status, the server's (ADR 0038); the
  // raw status is the fallback before the root's row lands in the map.
  const workflowRunStatus =
    load.phase === "ready" && selection.rootRunId !== null
      ? (load.value.displayStatus.get(selection.rootRunId) ?? load.value.status)
      : null;

  return { watch, projectionView, workflowRunStatus };
}
