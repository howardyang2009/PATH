import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { NodeIo, RunDetail, RunsList, type RunViewLoad } from "@path/viewer";
import { useRef, useState } from "react";
import { useDragSize } from "../drag-size.js";
import { usePaneWidths } from "../use-pane-resize.js";
import { RunLaunch } from "./run-launch.js";

/** Persisted open-dock height, in px. The panes inside scroll; this is the drawer's own height. */
const HEIGHT_KEY = "path.designer.run-dock-height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;
/** Never let the dock swallow the whole window — leave the authoring surface a floor. */
function maxHeight(): number {
  return typeof window === "undefined" ? 640 : Math.round(window.innerHeight * 0.8);
}

/** Persisted widths, in px, of the left (RUNS) and middle (RUN DETAIL) panes; the right pane fills the
 * rest. `[left, middle]`. */
const COLS_KEY = "path.designer.run-dock-cols";
const DEFAULT_COL = 260;
const MIN_COL = 180;
/** Total width the two vertical separators eat (2 × 6px), reserved when clamping. */
const VRESIZER_SPAN = 12;

export interface RunDockProps {
  client: PathApiClient;
  /**
   * Why the dock is disabled, or omitted when it is live. Set in template mode: a template never runs
   * (it is engine-blind, ADR 0051), so the dock stays closed and its toggle is disabled with this note.
   */
  disabledReason?: string;
  /** The file open on the canvas — the launch target; `null` for a never-saved buffer. */
  workflowPath: string | null;
  /** The open workflow's `id` — the run-list scope key; `null` when nothing is open. */
  workflowId: string | null;
  /**
   * The received step-plugin registry (`GET /v0/step-plugins`), handed to the launch form so its
   * **launch worker-default** field can offer each type's shipped workers (ADR 0044).
   */
  plugins: readonly WireStepPlugin[];
  /**
   * The open buffer's parsed file (the root level), or `null` when nothing is open. The
   * `Resume from …` button reads it to locate a top-level K in the file body — the eager legal-K check.
   */
  rootFile: WorkflowFile | null;
  /** The active buffer's dirty flag — gates save-first launch and the `Resume from …` clean-buffer gate. */
  dirty: boolean;
  /** The open file's soft cross-node warning count (#388) — badges launch, never blocks it. */
  warningCount: number;
  /** The live snapshot of the watched run (from the app's single connection). */
  load: RunViewLoad;
  rootRunId: string | null;
  selectedRunId: string | null;
  onSelectRootRun: (rootRunId: string) => void;
  onSelectRun: (runId: string) => void;
  onLaunched: (rootRunId: string) => void;
  onResumed: (successorRootRunId: string) => void;
  /** Drops the watched run if it was the one deleted, then forces the list to re-read. */
  onDeleted: (rootRunId: string) => void;
  /** Bumped by the app after a launch/resume so the list re-reads immediately. */
  reloadNonce: number;
}

/**
 * The Designer's run dock: the bottom-docked region that reuses the Viewer's three read panels —
 * `RunsList │ RunDetail │ NodeIo` (imported from `@path/viewer`, not re-implemented). The panels are
 * the same components the Viewer mounts, so a run reads identically on both surfaces; the Designer
 * only differs in scope (the list is scoped to the open file's `workflow_id`) and in what sits above
 * the list — the save-first launch form, which is a Designer-only affordance. The **projection** onto
 * the canvas nodes lives above, on the canvas itself; this dock is the *which/what* half of surface 6.
 *
 * Collapsed by default so the authoring surface owns the screen until the author reaches for a run; the
 * toggle is remembered only within the session (no persistence needed for a drawer).
 */
export function RunDock(props: RunDockProps): JSX.Element {
  const [expanded, setOpen] = useState(false);
  // A disabled dock stays closed, and re-opens as it was when it is live again.
  const open = expanded && props.disabledReason === undefined;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // The dock's own height: one drag-set dimension (handle on the top edge, drag up grows). The width
  // mechanics — the two column separators, left + middle with the node pane fluid on the right — are the
  // shared paired hook, the same one the app shell's rails use, so no resize logic lives here any more.
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

  // The selected run's record, taken from the same live snapshot the tree renders, so the node I/O
  // pane's refs and status stay current as the run executes (the Viewer app resolves it the same way).
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
        <div
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
          <span className="run-dock-caret" aria-hidden="true">{open ? "▾" : "▸"}</span> Runs
        </button>
        {props.disabledReason !== undefined ? <span className="run-dock-note">{props.disabledReason}</span> : null}
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
              // The `Resume from …` K-selection action rides in the selected row's action panel,
              // below plain Resume (ADR 0033). The Designer feeds it the watched tree, the selected
              // node as K, and its open buffer (`rootFile`/`dirty`) for the eager legal-K check —
              // one value, absent until the tree lands.
              resumeFrom={
                props.load.phase === "ready"
                  ? { runs: props.load.value.runs, selectedRunId: props.selectedRunId, rootFile: props.rootFile, dirty: props.dirty }
                  : undefined
              }
              // The watched run's display status, so its row reads `awaiting` while a leaf is parked
              // even though the list's summary status stays `running` (ADR 0038).
              displayStatus={props.load.phase === "ready" ? props.load.value.displayStatus : undefined}
            />
          </div>
          <div
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
              // The run tree here drives K for the `Resume from …` action, which itself lives in the
              // runs rail's action panel (left column) alongside plain Resume/Delete.
              <RunDetail
                client={props.client}
                load={props.load}
                rootRunId={props.rootRunId}
                selectedRunId={props.selectedRunId}
                onSelectRun={props.onSelectRun}
                // The open buffer is the run's root file here, so an awaiting leaf's assignee chip in the
                // rail resolves by node id — the same surface the Viewer draws (ADR 0031, #487). The
                // Designer resolves against the one open buffer; the Viewer widens this to the whole
                // reachable file set for a nested leaf.
                workflowFiles={props.rootFile ? [props.rootFile] : []}
              />
            )}
          </div>
          <div
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
              // Passing the open buffer lets an awaiting leaf's Complete slide-over build from the node's
              // `outputSchema` — the very same form the Viewer mounts, not a Designer fork (ADR 0031, #487).
              <NodeIo
                client={props.client}
                run={selectedRun}
                // One snapshot feeds the pane: it reads this run's display status and error off the view
                // rather than scanning the run map and the event narrative itself (ADR 0025/0031).
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
