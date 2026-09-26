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
 * The viewer app: the pinned three-pane console (#44 Variant A) with the runs-list surface in its
 * left pane (issue #46), the run-detail surface in its centre and the node I/O in its right. Both
 * selections are owned here — the root run being watched, and the run inside its tree whose I/O the
 * right pane resolves (map #40).
 *
 * The watched run's connection is owned here too, not by the detail pane: the centre and right panes
 * are two views of one live snapshot, and a second connection for the right pane would mean a second
 * SSE stream telling the same story a beat apart.
 *
 * A status-filter change in the runs list deliberately does not clear the selection: what is
 * selected is a root run id, not a visible row, and the detail pane resolves that id against the
 * server. Narrowing the list is not a reason to stop watching the run you were watching.
 */
export function App({ client }: { client: PathApiClient }) {
  const [selectedRootRunId, setSelectedRootRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runsReloadNonce, setRunsReloadNonce] = useState(0);
  const load = useRunView(client, selectedRootRunId);

  // The watched run's reachable workflow files: the root file and every file its `workflow` steps ref,
  // transitively (`loadReachableWorkflowFiles`). Two surfaces read them, both structural only (node
  // ids/types and control-body nesting, never the plugin-validated leaf shapes — so no step registry):
  //   - the eager `Resume from …` legal-K check needs the *root* file (`files[0]`) so the in-body /
  //     since-deleted / prefix reasons grey the button before the engine's refusal on click; and
  //   - the awaiting surface needs the *whole set*, because a `person-activity` leaf can live in a
  //     nested file, not only the root (issue #486 follow-up) — its `description`/`assignee` are read
  //     from the node by id wherever the node sits.
  // The Viewer authors nothing, so it reads from disk (a GET, no lease — ADR 0017). Empty while it
  // loads or if the root read/parse fails; the checks then fall back to the run-tree-derivable reasons
  // and the schema-less submit, and the engine backstops the rest.
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

  // Switching root run drops the node selection: a run id from the previous tree names nothing in
  // the new one, and the node pane would be left pointing at a run this root does not contain.
  const selectRootRun = (rootRunId: string): void => {
    setSelectedRootRunId(rootRunId);
    setSelectedRunId(null);
  };

  // A launch (#233) is the same transition as a click — select the new run so the centre pane
  // streams it — plus a nudge so the runs rail re-reads and shows the new row now, not at the next
  // periodic tick.
  const handleLaunched = (rootRunId: string): void => {
    selectRootRun(rootRunId);
    setRunsReloadNonce((nonce) => nonce + 1);
  };

  // A delete removes the run from both stores: if the centre pane was watching it, stop (its tree is
  // gone), and re-read the rail so the row disappears now rather than at the next periodic tick.
  const handleDeleted = (rootRunId: string): void => {
    if (rootRunId === selectedRootRunId) {
      setSelectedRootRunId(null);
      setSelectedRunId(null);
    }
    setRunsReloadNonce((nonce) => nonce + 1);
  };

  // The tree is the only source of the selected run: taking the record from the same snapshot the
  // tree renders is what keeps the pane's refs and status current as the run executes.
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
          // The `Resume from …` action lives in the selected row's action panel, below plain Resume.
          // The Viewer reads the watched run's root file (above) so the eager legal-K check greys the
          // button for the same reasons the Designer does — in-body, since-deleted, prefix — rather
          // than only on the engine's refusal. It never edits, so `dirty` stays false. K is the node
          // picked in the detail pane's run tree. Absent until the tree lands: without it there is no
          // affordance, and the panel offers plain Resume alone.
          resumeFrom={
            load.phase === "ready"
              ? { runs: load.value.runs, selectedRunId, rootFile, dirty: false }
              : undefined
          }
          // The watched run's display status, so its row reads `awaiting` while a leaf is parked even
          // though the list's summary status stays `running` (ADR 0038).
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
            // One snapshot feeds the pane: it reads this run's display status and error off the view
            // rather than scanning the run map and the event narrative itself (ADR 0025).
            view={load.phase === "ready" ? load.value : undefined}
            workflowFiles={workflowFiles}
          />
        )
      }
    />
  );
}
