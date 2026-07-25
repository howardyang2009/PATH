import type { PathApiClient } from "@path/client-core";
import { useState } from "react";
import { AppShell } from "./app-shell.js";
import { RunDetail } from "./run-detail.js";
import { RunsList } from "./runs-list.js";

/**
 * The viewer app: the pinned three-pane console (#44 Variant A) with the runs-list surface in its
 * left pane (issue #46) and the run-detail surface in its centre. Both selections are owned here —
 * the root run being watched, and the run inside its tree whose I/O the right pane resolves (map
 * #40).
 *
 * A status-filter change in the runs list deliberately does not clear the selection: what is
 * selected is a root run id, not a visible row, and the detail pane resolves that id against the
 * server. Narrowing the list is not a reason to stop watching the run you were watching.
 */
export function App({ client }: { client: PathApiClient }) {
  const [selectedRootRunId, setSelectedRootRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Switching root run drops the node selection: a run id from the previous tree names nothing in
  // the new one, and the node pane would be left pointing at a run this root does not contain.
  const selectRootRun = (rootRunId: string): void => {
    setSelectedRootRunId(rootRunId);
    setSelectedRunId(null);
  };

  return (
    <AppShell
      runs={
        <RunsList
          client={client}
          selectedRootRunId={selectedRootRunId}
          onSelectRootRun={selectRootRun}
        />
      }
      detail={
        selectedRootRunId === null ? (
          <p className="pane-note">Select a run.</p>
        ) : (
          <RunDetail
            client={client}
            rootRunId={selectedRootRunId}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
          />
        )
      }
      nodeIo={<NodeIoPlaceholder selectedRunId={selectedRunId} />}
    />
  );
}

/** Until the node-I/O surface lands, the pane just proves the lifted run selection reached it. */
function NodeIoPlaceholder({ selectedRunId }: { selectedRunId: string | null }) {
  if (selectedRunId === null) return <p className="pane-note">Select a run in the tree.</p>;
  return (
    <p className="pane-note">
      <span className="run-id">{selectedRunId}</span> selected — masked input and output land here
      under map #40.
    </p>
  );
}
