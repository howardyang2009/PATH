import {
  loadReachableWorkflowFiles,
  type PathApiClient,
  type WorkflowFile,
} from "@path/client-core";
import { useEffect, useState } from "react";
import { AppShell } from "./app-shell.js";
import { LaunchPanel } from "./launch-panel.js";
import { NodeIo } from "./node-io.js";
import { RunDetail } from "./run-detail.js";
import { RunsList } from "./runs-list.js";
import { useRunView } from "./use-run-view.js";

/**
 * The viewer app: the pinned three-pane console with the runs list, run detail and node I/O panes. Both
 * selections are owned here, and so is the watched run's connection — the centre and right panes are two
 * views of one live snapshot, and a second connection would mean a second SSE stream.
 *
 * A status-filter change in the runs list does not clear the selection: what is selected is a root run
 * id, not a visible row, so narrowing the list is no reason to stop watching.
 */
export function App({ client }: { client: PathApiClient }) {
  const [selectedRootRunId, setSelectedRootRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runsReloadNonce, setRunsReloadNonce] = useState(0);
  const load = useRunView(client, selectedRootRunId);

  // The watched run's reachable workflow files (root + transitively-ref'd), read from disk (a GET, no
  // lease — ADR 0017). The eager `Resume from …` legal-K check needs the root file (`files[0]`); the
  // awaiting surface needs the whole set, since a `person-activity` leaf can live in a nested file. Empty
  // while loading or on a failed read: the checks fall back to run-tree-derivable reasons.
  const [workflowFiles, setWorkflowFiles] = useState<readonly WorkflowFile[]>([]);
  const rootFile = workflowFiles[0] ?? null;
  const rootWorkflowPath =
    load.phase === "ready" && selectedRootRunId !== null
      ? (load.value.runs.get(selectedRootRunId)?.workflowPath ?? null)
      : null;
  useEffect(() => {
    if (rootWorkflowPath === null) {
      setWorkflowFiles([]);
      return;
    }
    let cancelled = false;
    setWorkflowFiles([]);
    loadReachableWorkflowFiles(client, rootWorkflowPath)
      .then((files) => {
        if (!cancelled) setWorkflowFiles(files);
      })
      .catch(() => {
        if (!cancelled) setWorkflowFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, rootWorkflowPath]);

  // Switching root run drops the node selection: a run id from the previous tree names nothing here.
  const selectRootRun = (rootRunId: string): void => {
    setSelectedRootRunId(rootRunId);
    setSelectedRunId(null);
  };

  // A launch is a click plus a nudge, so the runs rail re-reads now rather than at the next tick.
  const handleLaunched = (rootRunId: string): void => {
    selectRootRun(rootRunId);
    setRunsReloadNonce((nonce) => nonce + 1);
  };

  // A delete clears the selection if the centre pane was watching it, and re-reads the rail.
  const handleDeleted = (rootRunId: string): void => {
    if (rootRunId === selectedRootRunId) {
      setSelectedRootRunId(null);
      setSelectedRunId(null);
    }
    setRunsReloadNonce((nonce) => nonce + 1);
  };

  // Taken from the same snapshot the tree renders, so refs and status stay current as the run executes.
  const selectedRun =
    load.phase === "ready" && selectedRunId !== null
      ? load.value.runs.get(selectedRunId)
      : undefined;

  return (
    <AppShell
      workflows={<LaunchPanel client={client} onLaunched={handleLaunched} />}
      runs={
        <RunsList
          client={client}
          selectedRootRunId={selectedRootRunId}
          onSelectRootRun={selectRootRun}
          onResumed={handleLaunched}
          onDeleted={handleDeleted}
          reloadNonce={runsReloadNonce}
          // The `Resume from …` action lives in the selected row's action panel, below plain Resume. It
          // reads the watched run's root file so the eager legal-K check greys the button like the
          // Designer's; the Viewer never edits, so `dirty` stays false.
          resumeFrom={
            load.phase === "ready"
              ? { runs: load.value.runs, selectedRunId, rootFile, dirty: false }
              : undefined
          }
          // The watched run's display status, so its row reads `awaiting` while a leaf is parked (ADR 0038).
          displayStatus={load.phase === "ready" ? load.value.displayStatus : undefined}
        />
      }
      detail={
        selectedRootRunId === null ? (
          <p className="pane-note">Select a run.</p>
        ) : (
          <RunDetail
            client={client}
            load={load}
            rootRunId={selectedRootRunId}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
            workflowFiles={workflowFiles}
          />
        )
      }
      nodeIo={
        selectedRun === undefined ? (
          <p className="pane-note">Select a run in the tree.</p>
        ) : (
          <NodeIo
            client={client}
            run={selectedRun}
            // One snapshot feeds the pane: it reads this run's display status and error off the view (ADR 0025).
            view={load.phase === "ready" ? load.value : undefined}
            workflowFiles={workflowFiles}
          />
        )
      }
    />
  );
}
