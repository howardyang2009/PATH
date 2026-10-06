import type { UserMenuItem } from "@path/client-core";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { UserMenu } from "./auth-gate.js";
import { useDragSize } from "./drag-size.js";
import { type PaneHandleProps, usePaneWidths } from "./use-pane-resize.js";

export interface AppShellProps {
  /** Top of the left rail: workflow discovery + inline launch. */
  workflows: ReactNode;
  /** Bottom of the left rail: the runs list with its status filter. */
  runs: ReactNode;
  detail: ReactNode;
  nodeIo: ReactNode;
  /** Entries for the hosted user menu. */
  menuItems?: UserMenuItem[];
}

/** Persisted rail widths, in px. The centre pane stays fluid (`1fr`). */
const STORAGE_KEY = "path.viewer.rail-widths";
const DEFAULT_LEFT = 300;
const DEFAULT_RIGHT = 340;
/** Keep each rail usable and never let it starve the fluid centre. */
const MIN_RAIL = 180;
const MAX_RAIL = 640;
/** Total width the two vertical separators eat (2 × 6px), reserved when clamping. */
const RAIL_VRESIZER_SPAN = 12;

/**
 * The pinned app frame: **Variant A, the three-pane console** —
 * `runs list │ run detail │ node I/O`. The panes are co-visible by design: a read-only monitor
 * watches a run live while inspecting a node, so no tab switch may drop the live narrative.
 *
 * The two rails are drag-resizable. Widths clamp to `[MIN_RAIL, MAX_RAIL]` and persist in
 * `localStorage`, so the fluid centre never starves.
 */
export function AppShell({ workflows, runs, detail, nodeIo, menuItems }: AppShellProps) {
  const panesRef = useRef<HTMLDivElement>(null);
  // The left handle grows its rail towards the right (+1); the right handle is mirrored (-1).
  const { widths, handleProps } = usePaneWidths({
    storageKey: STORAGE_KEY,
    defaults: [DEFAULT_LEFT, DEFAULT_RIGHT],
    min: MIN_RAIL,
    max: MAX_RAIL,
    fluidMin: 0,
    separatorSpan: RAIL_VRESIZER_SPAN,
    containerRef: panesRef,
    grow: [1, -1],
  });

  const style = {
    gridTemplateColumns: `${widths[0]}px 6px 1fr 6px ${widths[1]}px`,
  } as CSSProperties;

  return (
    <div className="shell">
      <TopBar sub="viewer · read-only" menuItems={menuItems} />
      <div className="panes" ref={panesRef} style={style}>
        <LeftRail workflows={workflows} runs={runs} />
        <Resizer rail="left" {...handleProps(0)} />
        <Pane id="pane-detail" title="Run detail">
          {detail}
        </Pane>
        <Resizer rail="right" {...handleProps(1)} />
        <Pane id="pane-io" title="Node I/O/C/E">
          {nodeIo}
        </Pane>
      </div>
    </div>
  );
}

/** The Viewer's top bar: the brand and `sub`, then the hosted user menu at the right end. */
export function TopBar({ sub, menuItems }: { sub: string; menuItems?: UserMenuItem[] }) {
  return (
    <header className="topbar">
      <span className="brand">PATH</span>
      <span className="brand-sub">{sub}</span>
      <UserMenu items={menuItems} />
    </header>
  );
}

/** Persisted height of the workflows panel (top of the left rail), in px. Runs take the rest. */
const LEFT_SPLIT_KEY = "path.viewer.workflows-height";
const DEFAULT_WORKFLOWS_HEIGHT = 220;
const MIN_WORKFLOWS_HEIGHT = 80;
/** Leave at least this much for the runs list so the workflows panel can never swallow the rail. */
const MIN_RUNS_HEIGHT = 140;

/**
 * The left rail, split top/bottom: **Workflows** above (discovery + inline launch), **Runs** below.
 * One drag-resizable divider between them, the vertical mirror of the column resizers. The
 * workflows panel's height is persisted; the runs list takes what is left, since it is the surface
 * that keeps growing.
 */
function LeftRail({ workflows, runs }: { workflows: ReactNode; runs: ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);
  const { size: height, handleProps } = useDragSize({
    storageKey: LEFT_SPLIT_KEY,
    defaultSize: DEFAULT_WORKFLOWS_HEIGHT,
    min: MIN_WORKFLOWS_HEIGHT,
    // Read live, so the cap follows the rail as the window resizes.
    max: () => (railRef.current?.clientHeight ?? Infinity) - MIN_RUNS_HEIGHT,
    axis: "y",
    grow: 1,
    cursor: "row-resize",
    ariaOrientation: "horizontal",
  });

  const style = { gridTemplateRows: `${height}px 8px 1fr` } as CSSProperties;

  return (
    <div className="left-rail" ref={railRef} style={style}>
      <Pane id="pane-workflows" title="Workflows">
        {workflows}
      </Pane>
      <hr className="row-resizer" aria-label="Resize workflows panel" {...handleProps} />
      <Pane id="pane-runs" title="Runs">
        {runs}
      </Pane>
    </div>
  );
}

/** A drag handle between two panes. Exposed as a `separator` so screen readers can resize it
 * too. */
function Resizer({ rail, ...handle }: { rail: "left" | "right" } & PaneHandleProps) {
  return (
    <hr
      className="pane-resizer"
      aria-label={`Resize ${rail === "left" ? "runs" : "node I/O/C/E"} pane`}
      aria-valuemax={MAX_RAIL}
      {...handle}
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
