import type { PathApiClient } from "@path/client-core";
import { useState } from "react";
import { AppShell } from "./app-shell.js";
import { RunsList } from "./runs-list.js";

/**
 * The viewer app: the pinned three-pane console (#44 Variant A) with the runs-list surface in its
 * left pane (issue #46). The selected root run id is owned here — the runs list lifts it, and the
 * run-detail and node-I/O surfaces read it once they graduate into their panes (map #40).
 */
export function App({ client }: { client: PathApiClient }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  return (
    <AppShell
      runs={
        <RunsList client={client} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
      }
      detail={<DetailPlaceholder selectedRunId={selectedRunId} />}
      io={
        <p className="pane-note">
          The node I/O panel lands with the run-tree surface, under map #40.
        </p>
      }
    />
  );
}

/** Until the run-detail surface lands, the pane just proves the lifted selection reached it. */
function DetailPlaceholder({ selectedRunId }: { selectedRunId: string | null }) {
  if (selectedRunId === null) return <p className="pane-note">Select a run.</p>;
  return (
    <p className="pane-note">
      <span className="run-id">{selectedRunId}</span> selected — status, run tree and live narrative
      land here under map #40.
    </p>
  );
}
