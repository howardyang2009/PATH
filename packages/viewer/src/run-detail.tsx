import { isTerminal, type PathApiClient } from "@path/client-core";
import { CancelButton } from "./cancel-button.js";
import { ResumeButton } from "./resume-button.js";
import { formatTimestamp } from "./format-time.js";
import { Narrative } from "./narrative.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { RunTree } from "./run-tree.js";
import { StatusPill } from "./status-pill.js";
import type { RunViewLoad } from "./use-run-view.js";

export interface RunDetailProps {
  client: PathApiClient;
  /** The live snapshot of the watched root run, owned by the app: one connection feeds two panes. */
  load: RunViewLoad;
  rootRunId: string;
  /** The run the node-I/O pane is showing, owned above so both panes agree on it. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /** Switches the app to watch the successor of a resumed run — the same transition a launch makes. */
  onResumed: (successorRootRunId: string) => void;
}

/**
 * The run-detail read surface: root-run status plus the indented run tree, in the centre pane of
 * the pinned console (#44 Variant A), with the live narrative under it (#48). Status, tree and
 * narrative are all live off one connection — the view-model folds the SSE stream in as the run
 * executes, and reopening a run mid-flight replays its history (map #40's watch verb). That
 * connection is held by the app rather than by this pane, because the node-I/O pane reads the same
 * snapshot to know when the run it is showing has written its output.
 */
export function RunDetail({ client, load, rootRunId, selectedRunId, onSelectRun, onResumed }: RunDetailProps) {
  if (load.phase === "idle" || load.phase === "loading") return <PaneLoading what="run" />;
  if (load.phase === "error") return <PaneError what="run" message={load.message} />;

  const state = load.value;
  const root = state.runs.get(rootRunId);
  // A terminal run has nothing to cancel (#56) — the button is absent, not disabled-and-explaining.
  const cancellable = !isTerminal(state.status);
  // Its mirror on the finished side: a run that stopped short — `cancelled` or `failed` — can be
  // resumed as a successor (§4.3). A `succeeded` run has nothing to resume, so no button.
  const resumable = state.status === "cancelled" || state.status === "failed";

  return (
    <div className="run-detail">
      <header className="run-head" data-testid="run-head">
        <span className="run-id">{state.rootRunId}</span>
        <StatusPill status={state.status} />
        {cancellable && <CancelButton client={client} rootRunId={rootRunId} />}
        {resumable && <ResumeButton client={client} rootRunId={rootRunId} onResumed={onResumed} />}
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
