import type { ReactNode } from "react";

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
  return (
    <div className="shell" data-has-dock={runDock ? "true" : "false"}>
      <header className="topbar">
        <span className="brand">PATH</span>
        <span className="brand-sub">designer · authoring</span>
        {toolbar ? <div className="toolbar">{toolbar}</div> : null}
      </header>
      <div className="panes">
        <section className="rail" aria-label="Palette">
          {palette}
        </section>
        <main className="stage">{canvas}</main>
        <aside className="pane-rail" role="region" aria-label="Properties">
          {pane}
        </aside>
      </div>
      {runDock ?? null}
    </div>
  );
}
