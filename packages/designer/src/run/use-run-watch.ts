import type { PathApiClient } from "@path/client-core";
import { useRunView } from "@path/viewer";
import { useRunSelection } from "@path/viewer/use-run-selection";

/** The Designer's run-watching state: one `useRunView` connection feeds both the canvas projection
 * and the inspector; the selection behind it is the one both consoles share
 * (`use-run-selection.ts`). */
export function useRunWatch(client: PathApiClient, rootWorkflowId: string | null) {
  // The open workflow is the selection's scope: a new root workflow names none of the watched run's
  // ids, so the selection re-bases — otherwise the run-detail pane and breadcrumb badge the new
  // workflow with the old run. Keyed on the root id, so a descent leaves it be.
  const selection = useRunSelection(rootWorkflowId);
  const load = useRunView(client, selection.rootRunId);
  // The root run has no `nodeId`, so it projects onto no canvas node; the App badges the breadcrumb
  // with it.
  const projectionView = load.phase === "ready" ? load.value : null;
  // The breadcrumb badge reads the root's **display** status, the server's (ADR 0038); the
  // raw status is the fallback before the root's row lands in the map.
  const workflowRunStatus =
    load.phase === "ready" && selection.rootRunId !== null
      ? (load.value.displayStatus.get(selection.rootRunId) ?? load.value.status)
      : null;

  return {
    load,
    projectionView,
    workflowRunStatus,
    rootRunId: selection.rootRunId,
    selectedRunId: selection.selectedRunId,
    reloadNonce: selection.reloadNonce,
    selectRootRun: selection.selectRootRun,
    selectRun: selection.selectRun,
    watchNewRun: selection.watchNewRun,
    onDeleted: selection.onDeleted,
  };
}
