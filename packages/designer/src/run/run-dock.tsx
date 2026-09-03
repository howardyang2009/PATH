import type { PathApiClient } from "@path/client-core";
import { NodeIo, RunDetail, RunsList, type RunViewLoad } from "@path/viewer";
import { useState } from "react";
import { RunLaunch } from "./run-launch.js";

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

  // The selected run's record, taken from the same live snapshot the tree renders, so the node I/O
  // pane's refs and status stay current as the run executes (the Viewer app resolves it the same way).
  const selectedRun =
    props.load.phase === "ready" && props.selectedRunId !== null
      ? props.load.value.runs.get(props.selectedRunId)
      : undefined;
  const narrative = props.load.phase === "ready" ? props.load.value.narrative : [];

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
          <div className="run-dock-col run-dock-runs">
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
          <div className="run-dock-col run-dock-detail">
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
