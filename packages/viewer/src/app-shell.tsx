import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface AppShellProps {
  /** Top of the left rail: workflow discovery + inline launch (#233). */
  workflows: ReactNode;
  /** Bottom of the left rail: the runs list with its status filter (#46). */
  runs: ReactNode;
  detail: ReactNode;
  nodeIo: ReactNode;
}

/** Persisted rail widths, in px. The centre pane stays fluid (`1fr`). */
const STORAGE_KEY = "path.viewer.rail-widths";
const DEFAULT_LEFT = 300;
const DEFAULT_RIGHT = 340;
/** Keep each rail usable and never let it starve the fluid centre. */
const MIN_RAIL = 180;
const MAX_RAIL = 640;

interface RailWidths {
  left: number;
  right: number;
}

function clampRail(px: number): number {
  return Math.min(MAX_RAIL, Math.max(MIN_RAIL, px));
}

function loadWidths(): RailWidths {
  if (typeof localStorage === "undefined") return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
    const parsed = JSON.parse(raw) as Partial<RailWidths>;
    return {
      left: clampRail(Number(parsed.left) || DEFAULT_LEFT),
      right: clampRail(Number(parsed.right) || DEFAULT_RIGHT),
    };
  } catch {
    return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
  }
}

/**
 * The pinned app frame: **Variant A, the three-pane console** (#44 decision) —
 * `runs list │ run detail │ node I/O`. The panes are co-visible by design: a read-only monitor
 * watches a run live while inspecting a node, so no tab switch may drop the live narrative. Slots
 * only — each surface graduates into its pane in its own ticket under map #40.
 *
 * The two rails are drag-resizable: grab the divider between panes to widen or narrow it. Widths
 * clamp to `[MIN_RAIL, MAX_RAIL]` and persist in `localStorage`, so the fluid centre never starves.
 */
export function AppShell({ workflows, runs, detail, nodeIo }: AppShellProps) {
  const [widths, setWidths] = useState<RailWidths>(loadWidths);
  const panesRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ rail: "left" | "right"; startX: number; startWidth: number } | null>(
    null,
  );

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {
      /* storage full or blocked — a non-persisted resize still works this session */
    }
  }, [widths]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // The left divider grows the rail as the pointer moves right; the right divider is mirrored.
    const delta = e.clientX - drag.startX;
    const next = clampRail(drag.startWidth + (drag.rail === "left" ? delta : -delta));
    setWidths((w) => ({ ...w, [drag.rail]: next }));
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  }, [onPointerMove]);

  const startDrag = useCallback(
    (rail: "left" | "right") => (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { rail, startX: e.clientX, startWidth: widths[rail] };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
    },
    [widths, onPointerMove, endDrag],
  );

  // Keyboard resize: arrows nudge the focused divider so the layout is reachable without a mouse.
  const onKeyDown = useCallback(
    (rail: "left" | "right") => (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 8;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setWidths((w) => ({ ...w, [rail]: clampRail(w[rail] + (rail === "left" ? -step : step)) }));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setWidths((w) => ({ ...w, [rail]: clampRail(w[rail] + (rail === "left" ? step : -step)) }));
      }
    },
    [],
  );

  const style = {
    gridTemplateColumns: `${widths.left}px 6px 1fr 6px ${widths.right}px`,
  } as React.CSSProperties;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">PATH</span>
        <span className="brand-sub">viewer · read-only</span>
      </header>
      <div className="panes" ref={panesRef} style={style}>
        <LeftRail workflows={workflows} runs={runs} />
        <Resizer
          rail="left"
          width={widths.left}
          onPointerDown={startDrag("left")}
          onKeyDown={onKeyDown("left")}
        />
        <Pane id="pane-detail" title="Run detail">
          {detail}
        </Pane>
        <Resizer
          rail="right"
          width={widths.right}
          onPointerDown={startDrag("right")}
          onKeyDown={onKeyDown("right")}
        />
        <Pane id="pane-io" title="Node I/O/C">
          {nodeIo}
        </Pane>
      </div>
    </div>
  );
}

/** Persisted height of the workflows panel (top of the left rail), in px. Runs take the rest. */
const LEFT_SPLIT_KEY = "path.viewer.workflows-height";
const DEFAULT_WORKFLOWS_HEIGHT = 220;
const MIN_WORKFLOWS_HEIGHT = 80;
/** Leave at least this much for the runs list so the workflows panel can never swallow the rail. */
const MIN_RUNS_HEIGHT = 140;

function loadWorkflowsHeight(): number {
  if (typeof localStorage === "undefined") return DEFAULT_WORKFLOWS_HEIGHT;
  const raw = Number(localStorage.getItem(LEFT_SPLIT_KEY));
  return raw >= MIN_WORKFLOWS_HEIGHT ? raw : DEFAULT_WORKFLOWS_HEIGHT;
}

/**
 * The left rail, split top/bottom: **Workflows** above (discovery + inline launch), **Runs** below
 * (the status-filtered run list). Two landmark panes, one drag-resizable divider between them — the
 * vertical mirror of the column resizers, sharing the `.row-resizer` handle the run-detail pane uses.
 * The workflows panel's height is drag-set and persisted; the runs list takes whatever is left, since
 * it is the surface that keeps growing.
 */
function LeftRail({ workflows, runs }: { workflows: ReactNode; runs: ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>(loadWorkflowsHeight);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(LEFT_SPLIT_KEY, String(Math.round(height)));
    } catch {
      /* storage blocked — resize still works this session */
    }
  }, [height]);

  const clamp = useCallback((px: number) => {
    const cap = (railRef.current?.clientHeight ?? Infinity) - MIN_RUNS_HEIGHT;
    return Math.max(MIN_WORKFLOWS_HEIGHT, Math.min(cap, px));
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setHeight(clamp(drag.startHeight + (e.clientY - drag.startY)));
    },
    [clamp],
  );

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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 8;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHeight((h) => clamp(h - step));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHeight((h) => clamp(h + step));
      }
    },
    [clamp],
  );

  const style = { gridTemplateRows: `${height}px 8px 1fr` } as React.CSSProperties;

  return (
    <div className="left-rail" ref={railRef} style={style}>
      <Pane id="pane-workflows" title="Workflows">
        {workflows}
      </Pane>
      <div
        className="row-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize workflows panel"
        aria-valuenow={Math.round(height)}
        aria-valuemin={MIN_WORKFLOWS_HEIGHT}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
      />
      <Pane id="pane-runs" title="Runs">
        {runs}
      </Pane>
    </div>
  );
}

/** A drag handle between two panes. Exposed as a `separator` so screen readers can resize it too. */
function Resizer({
  rail,
  width,
  onPointerDown,
  onKeyDown,
}: {
  rail: "left" | "right";
  width: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${rail === "left" ? "runs" : "node I/O/C"} pane`}
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_RAIL}
      aria-valuemax={MAX_RAIL}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/** One pane: a landmark region named by its own heading, so each surface is reachable by name. */
function Pane({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const titleId = `${id}-title`;
  return (
    <section className="pane" id={id} aria-labelledby={titleId}>
      <header className="pane-head">
        <h2 className="pane-title" id={titleId}>
          {title}
        </h2>
      </header>
      <div className="pane-body">{children}</div>
    </section>
  );
}
