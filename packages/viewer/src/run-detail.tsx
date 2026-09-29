import {
  EMPTY_RUN_FILE_SET,
  isTerminal,
  type PathApiClient,
  type RunFileSet,
} from "@path/client-core";
import { useRef } from "react";
import { CancelButton } from "./cancel-button.js";
import { useDragSize } from "./drag-size.js";
import { Narrative } from "./narrative.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { RunTree } from "./run-tree.js";
import { StatusPill } from "./status-pill.js";
import type { RunViewLoad } from "./use-run-view.js";

/** Persisted run-tree height, in px. The narrative below takes whatever is left. */
const TREE_HEIGHT_KEY = "path.viewer.tree-height";
const DEFAULT_TREE_HEIGHT = 220;
const MIN_TREE_HEIGHT = 80;
/** Leave at least this much for the narrative so the tree can never swallow the whole pane. */
const MIN_NARRATIVE = 120;

export interface RunDetailProps {
  client: PathApiClient;
  /** The live snapshot of the watched root run, owned by the app: one connection feeds two
   * panes. */
  load: RunViewLoad;
  rootRunId: string;
  /** The run the node-I/O pane is showing, owned above so both panes agree on it. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /**
   * The files a run's node ids resolve against, for an awaiting leaf's assignee chip in the rail —
   * the node may sit in a nested file, not only the root.
   */
  runFiles?: RunFileSet;
}

/**
 * The run-detail read surface: root-run status plus the indented run tree, with the live narrative
 * under it. Status, tree and narrative are all live off one connection — the view-model folds the
 * SSE stream in as the run executes, and reopening a run mid-flight replays its history. That
 * connection is held by the app rather than by this pane, because the node-I/O pane reads the same
 * snapshot.
 */
export function RunDetail({
  client,
  load,
  rootRunId,
  selectedRunId,
  onSelectRun,
  runFiles = EMPTY_RUN_FILE_SET,
}: RunDetailProps) {
  const detailRef = useRef<HTMLDivElement>(null);
  // The tree/narrative split: the handle sits below the tree, so dragging down (+1) grows it, and
  // the narrative keeps its floor.
  const { size: treeHeight, handleProps: treeHandleProps } = useDragSize({
    storageKey: TREE_HEIGHT_KEY,
    defaultSize: DEFAULT_TREE_HEIGHT,
    min: MIN_TREE_HEIGHT,
    max: () => (detailRef.current?.clientHeight ?? Infinity) - MIN_NARRATIVE,
    axis: "y",
    grow: 1,
    cursor: "row-resize",
    ariaOrientation: "horizontal",
  });

  if (load.phase === "idle" || load.phase === "loading") return <PaneLoading what="run" />;
  if (load.phase === "error") return <PaneError what="run" message={load.message} />;

  const state = load.value;
  const root = state.runs.get(rootRunId);
  // The head shows the fact the view published, so it agrees with the rail, the tree and the node
  // pane: a root whose leaf is parked reads `awaiting` although its record stays `running` (ADR
  // 0038). A root the map does not hold yet (its row has not arrived) falls back to the snapshot's
  // own status.
  const displayStatus = state.displayStatus.get(rootRunId) ?? state.status;
  // Several leaves can await at once (parallel joins, ADR 0042). The rail carries a count badge
  // when more than one does, so the operator sees at a glance there is more than the selected one
  // to act on.
  const awaitingCount = state.awaitingRunIds.size;
  // A terminal run has nothing to cancel — the button is absent, not disabled-and-explaining. The
  // finished-side mirror, Resume, lives in the runs rail (under the selected row), not here.
  const cancellable = !isTerminal(state.status);

  return (
    <div className="run-detail" ref={detailRef}>
      <header className="run-head" data-testid="run-head">
        <span className="run-workflow-name">{root?.workflowName ?? "—"}</span>
        <StatusPill status={displayStatus} />
        {cancellable && <CancelButton client={client} rootRunId={rootRunId} />}
        <dl className="run-meta-grid">
          <dt>workflow id</dt>
          <dd className="run-workflow-id">{root?.workflowId ?? "—"}</dd>
          <dt>workflow file</dt>
          <dd className="run-workflow-path">{root?.workflowPath ?? "—"}</dd>
        </dl>
      </header>

      <section
        className="run-section"
        aria-labelledby="run-tree-title"
        style={{ height: treeHeight }}
      >
        <header className="card-head">
          <h3 className="card-title" id="run-tree-title">
            Run tree
          </h3>
          {awaitingCount >= 2 && (
            <span className="awaiting-count-badge" data-testid="awaiting-count-badge">
              {awaitingCount} awaiting
            </span>
          )}
          <span className="card-count">{state.runs.size} runs</span>
        </header>
        <RunTree
          rootRunId={rootRunId}
          runs={state.runs}
          displayStatus={state.displayStatus}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
          runFiles={runFiles}
        />
      </section>

      <hr className="row-resizer" aria-label="Resize run tree" {...treeHandleProps} />

      <Narrative events={state.narrative} stream={state.stream} />
    </div>
  );
}
