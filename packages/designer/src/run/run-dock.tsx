import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { NodeIo, RunDetail, RunsList, type RunViewLoad } from "@path/viewer";
import { useRef, useState } from "react";
import { useDragSize } from "../drag-size.js";
import { usePaneWidths } from "../use-pane-resize.js";
import { RunLaunch } from "./run-launch.js";

/** Persisted open-dock height, in px; the panes inside scroll. */
const HEIGHT_KEY = "path.designer.run-dock-height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;
/** Never let the dock swallow the whole window — leave the authoring surface a floor. */
function maxHeight(): number {
  return typeof window === "undefined" ? 640 : Math.round(window.innerHeight * 0.8);
}

/** Persisted widths, in px, of the left (RUNS) and middle (RUN DETAIL) panes; `[left, middle]`. */
const COLS_KEY = "path.designer.run-dock-cols";
const DEFAULT_COL = 260;
const MIN_COL = 180;
/** Width the two vertical separators eat (2 × 6px), reserved when clamping. */
const VRESIZER_SPAN = 12;

export interface RunDockProps {
  client: PathApiClient;
  /** Why the dock is disabled, or omitted when live; set in template mode, which never runs. */
  disabledReason?: string;
  /** The file open on the canvas — the launch target; `null` for a never-saved buffer. */
  workflowPath: string | null;
  workflowId: string | null;
  /** The step-plugin registry, handed to the launch form for its worker-default field (ADR 0044). */
  plugins: readonly WireStepPlugin[];
  /** The open buffer's parsed root file, or `null`; the `Resume from …` button reads it for the eager
   * legal-K check. */
  rootFile: WorkflowFile | null;
  /** The active buffer's dirty flag — gates save-first launch and the `Resume from …` clean-buffer gate. */
  dirty: boolean;
  /** The open file's soft cross-node warning count — badges launch, never blocks it. */
  warningCount: number;
  load: RunViewLoad;
  rootRunId: string | null;
  selectedRunId: string | null;
  onSelectRootRun: (rootRunId: string) => void;
  onSelectRun: (runId: string) => void;
  onLaunched: (rootRunId: string) => void;
  onResumed: (successorRootRunId: string) => void;
  /** Drops the watched run if it was the one deleted, then forces the list to re-read. */
  onDeleted: (rootRunId: string) => void;
  reloadNonce: number;
}

/**
 * The Designer's run dock: the bottom-docked region reusing the Viewer's three read panels (`RunsList
 * │ RunDetail │ NodeIo`), so a run reads identically on both surfaces; the Designer adds scope (the
 * open file's `workflow_id`) and the save-first launch form above the list. Collapsed by default, with
 * expansion remembered only within the session.
 */
export function RunDock(props: RunDockProps): JSX.Element {
  const [expanded, setOpen] = useState(false);
  // A disabled dock stays closed, and re-opens as it was when it is live again.
  const open = expanded && props.disabledReason === undefined;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // The dock's own height: one drag-set dimension (handle on the top edge, drag up grows). The width
  // mechanics are the shared paired hook the app shell's rails use.
  const dock = useDragSize({
    storageKey: HEIGHT_KEY,
    defaultSize: DEFAULT_HEIGHT,
    min: MIN_HEIGHT,
    max: maxHeight,
    axis: "y",
    grow: -1,
    cursor: "row-resize",
    ariaOrientation: "horizontal",
  });
  const cols = usePaneWidths({
    storageKey: COLS_KEY,
    defaults: [DEFAULT_COL, DEFAULT_COL],
    min: MIN_COL,
    fluidMin: MIN_COL,
    separatorSpan: VRESIZER_SPAN,
    containerRef: bodyRef,
    grow: [1, 1],
  });

  // The selected run's record, taken from the same live snapshot the tree renders.
  const selectedRun =
    props.load.phase === "ready" && props.selectedRunId !== null
      ? props.load.value.runs.get(props.selectedRunId)
      : undefined;

  return (
    <section
      className="run-dock"
      data-open={open ? "true" : "false"}
      aria-label="Runs"
      // The open dock's height is drag-set; closed, it collapses to just its toggle bar.
      style={open ? { height: `${dock.size}px` } : undefined}
    >
      {open && (
        <hr
          className="run-dock-resizer"
          aria-label="Resize runs panel"
          data-testid="run-dock-resizer"
          {...dock.handleProps}
        />
      )}
      <header className="run-dock-bar">
        <button
          type="button"
          className="run-dock-toggle"
          data-testid="run-dock-toggle"
          aria-expanded={open}
          disabled={props.disabledReason !== undefined}
          onClick={() => setOpen((shown) => !shown)}
        >
          <span className="run-dock-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>{" "}
          Runs
        </button>
        {props.disabledReason !== undefined ? (
          <span className="run-dock-note">{props.disabledReason}</span>
        ) : null}
      </header>
      {open && (
        <div className="run-dock-body" ref={bodyRef}>
          <div className="run-dock-col run-dock-runs" style={{ width: `${cols.widths[0]}px` }}>
            <div className="run-dock-launch">
              <RunLaunch
                client={props.client}
                plugins={props.plugins}
                workflowPath={props.workflowPath}
                dirty={props.dirty}
                warningCount={props.warningCount}
                onLaunched={props.onLaunched}
              />
            </div>
            <hr className="run-dock-sep" />
            <h3 className="run-dock-heading">Runs</h3>
            <RunsList
              client={props.client}
              workflowId={props.workflowId}
              selectedRootRunId={props.rootRunId}
              onSelectRootRun={props.onSelectRootRun}
              onResumed={props.onResumed}
              onDeleted={props.onDeleted}
              reloadNonce={props.reloadNonce}
              // The `Resume from …` K-selection action rides in the selected row's action panel below
              // plain Resume (ADR 0033), fed the watched tree and the open buffer for the legal-K check.
              resumeFrom={
                props.load.phase === "ready"
                  ? {
                      runs: props.load.value.runs,
                      selectedRunId: props.selectedRunId,
                      rootFile: props.rootFile,
                      dirty: props.dirty,
                    }
                  : undefined
              }
              // So the row reads `awaiting` while a leaf is parked, though summary status stays `running` (ADR 0038).
              displayStatus={
                props.load.phase === "ready" ? props.load.value.displayStatus : undefined
              }
            />
          </div>
          <hr
            className="run-dock-vresizer"
            aria-label="Resize runs list"
            data-testid="run-dock-vresizer-0"
            {...cols.handleProps(0)}
          />
          <div className="run-dock-col run-dock-detail" style={{ width: `${cols.widths[1]}px` }}>
            <h3 className="run-dock-heading">Run detail</h3>
            {props.rootRunId === null ? (
              <p className="pane-note">Select a run.</p>
            ) : (
              // The run tree here drives K for the `Resume from …` action in the runs rail.
              <RunDetail
                client={props.client}
                load={props.load}
                rootRunId={props.rootRunId}
                selectedRunId={props.selectedRunId}
                onSelectRun={props.onSelectRun}
                // Passing the open buffer lets an awaiting leaf's assignee chip resolve by node id, the
                // same surface the Viewer draws; the Viewer widens this to the reachable file set.
                workflowFiles={props.rootFile ? [props.rootFile] : []}
              />
            )}
          </div>
          <hr
            className="run-dock-vresizer"
            aria-label="Resize run detail"
            data-testid="run-dock-vresizer-1"
            {...cols.handleProps(1)}
          />
          <div className="run-dock-col run-dock-io">
            <h3 className="run-dock-heading">Node I/O/C/E</h3>
            {selectedRun === undefined ? (
              <p className="pane-note">Select a run in the tree.</p>
            ) : (
              // Passing the open buffer lets an awaiting leaf's Complete form build from `outputSchema` (ADR 0031).
              <NodeIo
                client={props.client}
                run={selectedRun}
                // One snapshot feeds the pane: it reads this run's status and error off the view (ADR 0025/0031).
                view={props.load.phase === "ready" ? props.load.value : undefined}
                workflowFiles={props.rootFile ? [props.rootFile] : []}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
