import type { PathApiClient } from "@path/client-core";
import { NodeIo, RunDetail, RunsList, type RunViewLoad } from "@path/viewer";
import { useCallback, useEffect, useRef, useState } from "react";
import { RunLaunch } from "./run-launch.js";

/** Persisted open-dock height, in px. The panes inside scroll; this is the drawer's own height. */
const HEIGHT_KEY = "path.designer.run-dock-height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;
/** Never let the dock swallow the whole window — leave the authoring surface a floor. */
function maxHeight(): number {
  return typeof window === "undefined" ? 640 : Math.round(window.innerHeight * 0.8);
}

function clampHeight(px: number): number {
  return Math.max(MIN_HEIGHT, Math.min(maxHeight(), px));
}

function loadHeight(): number {
  if (typeof localStorage === "undefined") return DEFAULT_HEIGHT;
  const raw = Number(localStorage.getItem(HEIGHT_KEY));
  return raw >= MIN_HEIGHT ? clampHeight(raw) : DEFAULT_HEIGHT;
}

/** Persisted widths, in px, of the left (RUNS) and middle (RUN DETAIL) panes; the right pane fills the
 * rest. `[left, middle]`. */
const COLS_KEY = "path.designer.run-dock-cols";
const DEFAULT_COL = 260;
const MIN_COL = 180;
/** Total width the two vertical separators eat (2 × 6px), reserved when clamping. */
const VRESIZER_SPAN = 12;

type ColWidths = [number, number];

function loadColWidths(): ColWidths {
  if (typeof localStorage === "undefined") return [DEFAULT_COL, DEFAULT_COL];
  try {
    const parsed = JSON.parse(localStorage.getItem(COLS_KEY) ?? "");
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((n) => typeof n === "number" && n >= MIN_COL)
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    /* absent or malformed — fall back to the defaults */
  }
  return [DEFAULT_COL, DEFAULT_COL];
}

export interface RunDockProps {
  client: PathApiClient;
  /** The file open on the canvas — the launch target; `null` for a never-saved buffer. */
  workflowPath: string | null;
  /** The open workflow's `id` — the run-list scope key; `null` when nothing is open. */
  workflowId: string | null;
  /** The active buffer's dirty flag — gates save-first launch. */
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
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState<number>(loadHeight);
  const [colWidths, setColWidths] = useState<ColWidths>(loadColWidths);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const colDragRef = useRef<{ index: 0 | 1; startX: number; startWidth: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(HEIGHT_KEY, String(Math.round(height)));
    } catch {
      /* storage blocked — the resize still holds for this session */
    }
  }, [height]);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(colWidths.map(Math.round)));
    } catch {
      /* storage blocked — the resize still holds for this session */
    }
  }, [colWidths]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Drag up grows the dock, down shrinks it: the handle is on the dock's top edge.
    setHeight(clampHeight(drag.startHeight + (drag.startY - e.clientY)));
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  }, [onPointerMove]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startHeight: height };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
    },
    [height, onPointerMove, endDrag],
  );

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHeight((h) => clampHeight(h + step));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHeight((h) => clampHeight(h - step));
    }
  }, []);

  // Resize one of the two drag-set panes to `px`, keeping it and the panes it borders above `MIN_COL`.
  // `index` 0 sets the left pane's width, 1 the middle's; the right pane always absorbs the remainder.
  const setColWidth = useCallback((index: 0 | 1, px: number) => {
    setColWidths((prev) => {
      const bodyWidth = bodyRef.current?.clientWidth ?? 0;
      const other = prev[index === 0 ? 1 : 0];
      // Cap so the untouched pane and the right pane each keep their floor.
      const max =
        bodyWidth > 0 ? Math.max(MIN_COL, bodyWidth - other - MIN_COL - VRESIZER_SPAN) : Infinity;
      const width = Math.max(MIN_COL, Math.min(max, px));
      const next: ColWidths = [...prev];
      next[index] = width;
      return next;
    });
  }, []);

  const onColPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = colDragRef.current;
      if (!drag) return;
      setColWidth(drag.index, drag.startWidth + (e.clientX - drag.startX));
    },
    [setColWidth],
  );

  const endColDrag = useCallback(() => {
    colDragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    window.removeEventListener("pointermove", onColPointerMove);
    window.removeEventListener("pointerup", endColDrag);
  }, [onColPointerMove]);

  const startColDrag = useCallback(
    (index: 0 | 1) => (e: React.PointerEvent) => {
      e.preventDefault();
      colDragRef.current = { index, startX: e.clientX, startWidth: colWidths[index] };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onColPointerMove);
      window.addEventListener("pointerup", endColDrag);
    },
    [colWidths, onColPointerMove, endColDrag],
  );

  const onColKeyDown = useCallback(
    (index: 0 | 1) => (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 8;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setColWidth(index, colWidths[index] - step);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setColWidth(index, colWidths[index] + step);
      }
    },
    [colWidths, setColWidth],
  );

  // The selected run's record, taken from the same live snapshot the tree renders, so the node I/O
  // pane's refs and status stay current as the run executes (the Viewer app resolves it the same way).
  const selectedRun =
    props.load.phase === "ready" && props.selectedRunId !== null
      ? props.load.value.runs.get(props.selectedRunId)
      : undefined;
  const narrative = props.load.phase === "ready" ? props.load.value.narrative : [];

  return (
    <section
      className="run-dock"
      data-open={open ? "true" : "false"}
      aria-label="Runs"
      // The open dock's height is drag-set; closed, it collapses to just its toggle bar.
      style={open ? { height: `${height}px` } : undefined}
    >
      {open && (
        <div
          className="run-dock-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize runs panel"
          aria-valuenow={Math.round(height)}
          aria-valuemin={MIN_HEIGHT}
          tabIndex={0}
          data-testid="run-dock-resizer"
          onPointerDown={startDrag}
          onKeyDown={onKeyDown}
        />
      )}
      <header className="run-dock-bar">
        <button
          type="button"
          className="run-dock-toggle"
          data-testid="run-dock-toggle"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
        >
          <span className="run-dock-caret" aria-hidden="true">{open ? "▾" : "▸"}</span> Runs
        </button>
      </header>
      {open && (
        <div className="run-dock-body" ref={bodyRef}>
          <div className="run-dock-col run-dock-runs" style={{ width: `${colWidths[0]}px` }}>
            <div className="run-dock-launch">
              <RunLaunch
                client={props.client}
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
            />
          </div>
          <div
            className="run-dock-vresizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize runs list"
            aria-valuenow={Math.round(colWidths[0])}
            aria-valuemin={MIN_COL}
            tabIndex={0}
            data-testid="run-dock-vresizer-0"
            onPointerDown={startColDrag(0)}
            onKeyDown={onColKeyDown(0)}
          />
          <div className="run-dock-col run-dock-detail" style={{ width: `${colWidths[1]}px` }}>
            <h3 className="run-dock-heading">Run detail</h3>
            {props.rootRunId === null ? (
              <p className="pane-note">Select a run.</p>
            ) : (
              <RunDetail
                client={props.client}
                load={props.load}
                rootRunId={props.rootRunId}
                selectedRunId={props.selectedRunId}
                onSelectRun={props.onSelectRun}
              />
            )}
          </div>
          <div
            className="run-dock-vresizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize run detail"
            aria-valuenow={Math.round(colWidths[1])}
            aria-valuemin={MIN_COL}
            tabIndex={0}
            data-testid="run-dock-vresizer-1"
            onPointerDown={startColDrag(1)}
            onKeyDown={onColKeyDown(1)}
          />
          <div className="run-dock-col run-dock-io">
            <h3 className="run-dock-heading">Node I/O/C/E</h3>
            {selectedRun === undefined ? (
              <p className="pane-note">Select a run in the tree.</p>
            ) : (
              <NodeIo client={props.client} run={selectedRun} narrative={narrative} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
