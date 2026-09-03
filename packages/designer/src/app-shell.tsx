import { type ReactNode, useRef } from "react";
import { usePaneWidths } from "./use-pane-resize.js";

/** Persisted widths, in px, of the palette rail and the properties rail; the canvas stage fills the
 * rest. `[palette, properties]`. Defaults match the old fixed grid columns (280 / 320). */
const RAILS_KEY = "path.designer.shell-rails";
const DEFAULT_RAILS: readonly [number, number] = [280, 320];
const MIN_RAIL = 200;
const MIN_STAGE = 240;
/** Total width the two vertical separators eat (2 × 6px), reserved when clamping. */
const RAIL_VRESIZER_SPAN = 12;

export interface AppShellProps {
  /** The left rail: the Steps + Blocks palette (§ The v1 authoring palette). */
  palette: ReactNode;
  /** The centre surface: the node canvas the workflow body is authored on. */
  canvas: ReactNode;
  /** The right rail: the properties pane that edits the selected node (or the file) (#369). */
  pane: ReactNode;
  /** The top-bar actions: save, and the edit-lease status/banners (#371). Absent with no file open. */
  toolbar?: ReactNode;
  /** The bottom-docked run surfaces: launch, run list, and the run inspector (#372). */
  runDock?: ReactNode;
}

/**
 * The Designer app frame — its own shell, not the Viewer's, though the run dock inside it reuses the
 * Viewer's run read panels (ADR 0031). The
 * layout is three landmark regions: the **palette** rail on the left, the **canvas** at the centre, and
 * (from #369) the **properties** pane on the right. Save and run still graduate in later tickets. The
 * frame exists so the empty canvas, the palette, and the pane load at `/designer/`.
 *
 * The brand strip says `designer · authoring`, the counterpart to the Viewer's `viewer · read-only`,
 * so the two peer surfaces are told apart at a glance.
 */
export function AppShell({ palette, canvas, pane, toolbar, runDock }: AppShellProps) {
  const panesRef = useRef<HTMLDivElement | null>(null);
  // Palette (handle on its right edge, grow +1) and properties (handle on its left edge, grow -1); the
  // canvas stage between them takes the remainder — the same model as the run dock's three panes.
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
        <span className="brand-sub">designer · authoring</span>
        {toolbar ? <div className="toolbar">{toolbar}</div> : null}
      </header>
      <div className="panes" ref={panesRef}>
        <section className="rail" aria-label="Palette" style={{ width: `${widths[0]}px` }}>
          {palette}
        </section>
        <div
          className="rail-vresizer"
          aria-label="Resize palette"
          data-testid="shell-vresizer-0"
          {...handleProps(0)}
        />
        <main className="stage">{canvas}</main>
        <div
          className="rail-vresizer"
          aria-label="Resize properties"
          data-testid="shell-vresizer-1"
          {...handleProps(1)}
        />
        <aside
          className="pane-rail"
          role="region"
          aria-label="Properties"
          style={{ width: `${widths[1]}px` }}
        >
          {pane}
        </aside>
      </div>
      {runDock ?? null}
    </div>
  );
}
