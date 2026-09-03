import type { PathApiClient } from "@path/client-core";
import { useState } from "react";
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
    load.phase === "ready" && selectedRunId !== null ? load.value.runs.get(selectedRunId) : undefined;

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
            narrative={load.phase === "ready" ? load.value.narrative : []}
          />
        )
      }
    />
  );
}
