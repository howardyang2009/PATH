import type { PathApiClient } from "@path/client-core";
import { formatTimestamp } from "./format-time.js";
import { Narrative } from "./narrative.js";
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
 * the pinned console (#44 Variant A), with the live narrative under it (#48). Status, tree and
 * narrative are all live off one connection — the view-model folds the SSE stream in as the run
 * executes, and reopening a run mid-flight replays its history (map #40's watch verb).
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

      <section className="run-section" aria-labelledby="run-tree-title">
        <header className="card-head">
          <h3 className="card-title" id="run-tree-title">
            Run tree
          </h3>
          <span className="card-count">{state.runs.size} runs</span>
        </header>
        <RunTree
          rootRunId={rootRunId}
          runs={state.runs}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
        />
      </section>

      <Narrative events={state.narrative} stream={state.stream} />
    </div>
  );
}
