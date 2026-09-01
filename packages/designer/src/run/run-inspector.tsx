import { isTerminal, type PathApiClient, type RunStatus } from "@path/client-core";
import { CancelButton } from "./cancel-button.js";
import { NodeIo } from "./node-io.js";
import { ResumeButton } from "./resume-button.js";
import { RunStatusPill } from "./run-status.js";
import { RunTree } from "./run-tree.js";
import type { RunViewLoad } from "./use-run-view.js";

export interface RunInspectorProps {
  client: PathApiClient;
  /** The live snapshot of the watched root run, owned by the app: one connection feeds the projection and this pane. */
  load: RunViewLoad;
  /** The watched root run, or `null` when nothing is selected. */
  rootRunId: string | null;
  /** The run whose I/O the pane shows, owned above so the tree and I/O block agree. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /** Switches the app to watch the successor of a resumed run — the same transition a launch makes. */
  onResumed: (successorRootRunId: string) => void;
}

/**
 * The run inspector (surfaces 3, 4, 6, 7 — ADR 0025): the head (root-run status, cancel/resume verbs),
 * the run tree, and the selected run's node I/O. The projection onto the canvas answers *where*; this
 * pane answers *which of a node's runs, and what did that one do*. It reads the same
 * `connectRunViewModel` snapshot the projection reads — one folded SSE stream, never a second connection.
 */
export function RunInspector({ client, load, rootRunId, selectedRunId, onSelectRun, onResumed }: RunInspectorProps): JSX.Element {
  if (rootRunId === null) {
    return <p className="run-note" data-testid="run-inspector-idle">Select a run to inspect it.</p>;
  }
  if (load.phase === "idle" || load.phase === "loading") {
    return <p className="run-note">Loading run…</p>;
  }
  if (load.phase === "error") {
    return (
      <p className="run-note run-error" role="alert">
        Failed to load run: {load.message}
      </p>
    );
  }

  const state = load.value;
  const root = state.runs.get(rootRunId);
  const status: RunStatus = state.status;
  const terminal = isTerminal(status);
  // A terminal run has nothing to cancel; a `cancelled`/`failed` one offers resume. `succeeded` offers
  // neither — there is nothing to recover.
  const resumable = status === "cancelled" || status === "failed";
  const selectedRun = selectedRunId !== null ? state.runs.get(selectedRunId) : undefined;

  return (
    <div className="run-inspector" data-testid="run-inspector">
      <header className="run-inspector-head">
        <span className="run-inspector-title">{root?.workflowName ?? "run"}</span>
        <RunStatusPill status={status} />
        {!terminal && <CancelButton client={client} rootRunId={rootRunId} />}
        <span className="run-inspector-id run-row-id">{rootRunId}</span>
      </header>

      {resumable && <ResumeButton client={client} rootRunId={rootRunId} onResumed={onResumed} />}

      <section className="run-inspector-tree" aria-label="Run tree">
        <RunTree rootRunId={rootRunId} runs={state.runs} selectedRunId={selectedRunId} onSelectRun={onSelectRun} />
      </section>

      <section className="run-inspector-io" aria-label="Node input and output">
        {selectedRun === undefined ? (
          <p className="run-note">Select a run in the tree to see its input and output.</p>
        ) : (
          <NodeIo client={client} run={selectedRun} />
        )}
      </section>
    </div>
  );
}
