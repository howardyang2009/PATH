import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface AppShellProps {
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
export function AppShell({ runs, detail, nodeIo }: AppShellProps) {
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
        <Pane id="pane-runs" title="Runs">
          {runs}
        </Pane>
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
        <Pane id="pane-io" title="Node I/O">
          {nodeIo}
        </Pane>
      </div>
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
      aria-label={`Resize ${rail === "left" ? "runs" : "node I/O"} pane`}
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
