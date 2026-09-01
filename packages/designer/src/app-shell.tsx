import type { ReactNode } from "react";

export interface AppShellProps {
  /** The left rail: the Steps + Blocks palette (§ The v1 authoring palette). */
  palette: ReactNode;
  /** The centre surface: the node canvas the workflow body is authored on. */
  canvas: ReactNode;
}

/**
 * The Designer app frame, a peer of the Viewer's shell but never an import of it (ADR 0028). The
 * tracer-bullet layout (#366) is two landmark regions: the **palette** rail on the left and the
 * **canvas** at the centre. It is deliberately thinner than the spec's full authoring surface — no
 * properties pane, no file breadcrumb, no open/save/run — because those graduate in later tickets. The
 * frame exists so the empty canvas and the palette shell load at `/designer/`.
 *
 * The brand strip says `designer · authoring`, the counterpart to the Viewer's `viewer · read-only`,
 * so the two peer surfaces are told apart at a glance.
 */
export function AppShell({ palette, canvas }: AppShellProps) {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">PATH</span>
        <span className="brand-sub">designer · authoring</span>
      </header>
      <div className="panes">
        <section className="rail" aria-label="Palette">
          {palette}
        </section>
        <main className="stage">{canvas}</main>
      </div>
    </div>
  );
}
