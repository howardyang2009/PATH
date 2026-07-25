import type { ReactNode } from "react";

export interface AppShellProps {
  runs: ReactNode;
  detail: ReactNode;
  nodeIo: ReactNode;
}

/**
 * The pinned app frame: **Variant A, the three-pane console** (#44 decision) —
 * `runs list │ run detail │ node I/O`. The panes are co-visible by design: a read-only monitor
 * watches a run live while inspecting a node, so no tab switch may drop the live narrative. Slots
 * only — each surface graduates into its pane in its own ticket under map #40.
 */
export function AppShell({ runs, detail, nodeIo }: AppShellProps) {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">PATH</span>
        <span className="brand-sub">viewer · read-only</span>
      </header>
      <div className="panes">
        <Pane id="pane-runs" title="Runs">
          {runs}
        </Pane>
        <Pane id="pane-detail" title="Run detail">
          {detail}
        </Pane>
        <Pane id="pane-io" title="Node I/O">
          {nodeIo}
        </Pane>
      </div>
    </div>
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
