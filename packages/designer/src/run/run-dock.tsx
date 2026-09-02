import type { PathApiClient } from "@path/client-core";
import { useState } from "react";
import { RunInspector } from "./run-inspector.js";
import { RunLaunch } from "./run-launch.js";
import { RunList } from "./run-list.js";
import type { RunViewLoad } from "./use-run-view.js";

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
  /** Bumped by the app after a launch/resume so the list re-reads immediately. */
  reloadNonce: number;
}

/**
 * The Designer's run dock: the bottom-docked region holding the three assembled run surfaces — launch
 * (save-first), the per-workflow run list, and the run inspector (tree + node I/O). The **projection**
 * onto the canvas nodes lives above, on the canvas itself; this dock is the *which/what* half of
 * surface 6. The pane geometry is the prototype's to pin (ADR 0025 leaves it open); a bottom dock keeps
 * the palette/canvas/properties columns intact and coexists with the properties pane.
 *
 * Collapsed by default so the authoring surface owns the screen until the author reaches for a run; the
 * toggle is remembered only within the session (no persistence needed for a drawer).
 */
export function RunDock(props: RunDockProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <section className="run-dock" data-open={open ? "true" : "false"} aria-label="Runs">
      <header className="run-dock-bar">
        <button
          type="button"
          className="run-dock-toggle"
          data-testid="run-dock-toggle"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open ? "▾" : "▸"} Runs
        </button>
      </header>
      {open && (
        <div className="run-dock-body">
          <div className="run-dock-col run-dock-launch">
            <h3 className="run-dock-heading">Run this workflow</h3>
            <RunLaunch
              client={props.client}
              workflowPath={props.workflowPath}
              dirty={props.dirty}
              warningCount={props.warningCount}
              onLaunched={props.onLaunched}
            />
          </div>
          <div className="run-dock-col run-dock-history">
            <h3 className="run-dock-heading">History</h3>
            <RunList
              client={props.client}
              workflowId={props.workflowId}
              selectedRootRunId={props.rootRunId}
              onSelectRootRun={props.onSelectRootRun}
              reloadNonce={props.reloadNonce}
            />
          </div>
          <div className="run-dock-col run-dock-inspect">
            <h3 className="run-dock-heading">Inspector</h3>
            <RunInspector
              client={props.client}
              load={props.load}
              rootRunId={props.rootRunId}
              selectedRunId={props.selectedRunId}
              onSelectRun={props.onSelectRun}
              onResumed={props.onResumed}
            />
          </div>
        </div>
      )}
    </section>
  );
}
