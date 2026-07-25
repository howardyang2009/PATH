import type { PathApiClient } from "@path/client-core";
import { formatTimestamp } from "./format-time.js";
import { RunTree } from "./run-tree.js";
import { StatusPill } from "./status-pill.js";
import { useRunView } from "./use-run-view.js";

export interface RunDetailProps {
  client: PathApiClient;
  rootRunId: string;
  /** The run the node-I/O pane is showing, owned above so both panes agree on it. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}

/**
 * The run-detail read surface: root-run status plus the indented run tree, in the centre pane of
 * the pinned console (#44 Variant A). Both the tree and the status are live — the view-model folds
 * the SSE narrative in as the run executes, and reopening a run mid-flight replays its history
 * (map #40's watch verb). The narrative list itself lands in its own ticket.
 */
export function RunDetail({ client, rootRunId, selectedRunId, onSelectRun }: RunDetailProps) {
  const load = useRunView(client, rootRunId);

  if (load.phase === "loading") return <p className="pane-note">Loading run…</p>;
  if (load.phase === "error") {
    return (
      <p className="pane-note pane-error" role="alert">
        Failed to load run: {load.message}
      </p>
    );
  }

  const state = load.value;
  const root = state.runs.get(rootRunId);

  return (
    <div className="run-detail">
      <header className="run-head" data-testid="run-head">
        <span className="run-id">{state.rootRunId}</span>
        <StatusPill status={state.status} />
        <span className="run-meta">{formatTimestamp(root?.startedAt ?? null)}</span>
      </header>

      <RunTree
        rootRunId={rootRunId}
        runs={state.runs}
        selectedRunId={selectedRunId}
        onSelectRun={onSelectRun}
      />
    </div>
  );
}
