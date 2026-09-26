import { type ReactNode, useRef } from "react";
import { usePaneWidths } from "./use-pane-resize.js";

/** Persisted `[palette, properties]` rail widths in px; the canvas stage fills the rest. */
const RAILS_KEY = "path.designer.shell-rails";
const DEFAULT_RAILS: readonly [number, number] = [280, 320];
const MIN_RAIL = 200;
const MIN_STAGE = 240;
/** Total width the two vertical separators eat (2 × 6px), reserved when clamping. */
const RAIL_VRESIZER_SPAN = 12;

export interface AppShellProps {
  palette: ReactNode;
  canvas: ReactNode;
  /** The right rail: the properties pane, editing the selected node or the file itself. */
  pane: ReactNode;
  modeSwitch?: ReactNode;
  title?: ReactNode;
  /** The top-bar actions: save, and the edit-lease status and banners. */
  toolbar?: ReactNode;
  /** The bottom-docked run surfaces: launch, run list, and the run inspector. */
  runDock?: ReactNode;
}

/**
 * The Designer app frame: its own shell, not the Viewer's, though its run dock reuses the Viewer's run read panels.
 */
export function AppShell({
  palette,
  canvas,
  pane,
  modeSwitch,
  title,
  toolbar,
  runDock,
}: AppShellProps) {
  const panesRef = useRef<HTMLDivElement | null>(null);
  // Palette handle grows +1 (right edge), properties -1 (left edge); the stage between takes the remainder.
  const { widths, handleProps } = usePaneWidths({
    storageKey: RAILS_KEY,
    defaults: DEFAULT_RAILS,
    min: MIN_RAIL,
    fluidMin: MIN_STAGE,
    separatorSpan: RAIL_VRESIZER_SPAN,
    containerRef: panesRef,
    grow: [1, -1],
  });

  return (
    <div className="shell" data-has-dock={runDock ? "true" : "false"}>
      <header className="topbar">
        <span className="brand">PATH</span>
        <span className="brand-sub">designer</span>
        {modeSwitch ?? null}
        {/* The centre slot always renders, so the toolbar keeps the right end with or without a title. */}
        <div className="topbar-title">{title ?? null}</div>
        {toolbar ? <div className="toolbar">{toolbar}</div> : null}
      </header>
      <div className="panes" ref={panesRef}>
        <section className="rail" aria-label="Palette" style={{ width: `${widths[0]}px` }}>
          {palette}
        </section>
        <hr
          className="rail-vresizer"
          aria-valuetext="Resize palette"
          data-testid="shell-vresizer-0"
          {...handleProps(0)}
        />
        <main className="stage">{canvas}</main>
        <hr
          className="rail-vresizer"
          aria-valuetext="Resize properties"
          data-testid="shell-vresizer-1"
          {...handleProps(1)}
        />
        <section className="pane-rail" aria-label="Properties" style={{ width: `${widths[1]}px` }}>
          {pane}
        </section>
      </div>
      {runDock ?? null}
    </div>
  );
}
