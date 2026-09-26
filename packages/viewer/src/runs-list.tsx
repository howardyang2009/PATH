import {
  isTerminal,
  type PathApiClient,
  type RootRunSummary,
  type RunNodeState,
  type RunStatus,
  type WorkflowFile,
} from "@path/client-core";
import { useEffect, useRef, useState } from "react";
import { DeleteButton } from "./delete-button.js";
import { formatTimestamp } from "./format-time.js";
import { errorMessage, type Load } from "./load-state.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { ResumeActions, type ResumeFromAffordance } from "./resume-actions.js";
import { ORDERED_RUN_STATUSES } from "./status-glyph.js";
import { StatusPill } from "./status-pill.js";

/**
 * Root runs the pane asks for. `GET /v0/runs` is most-recent-first (server-api-v0.md §3), so this is
 * a "latest N" window, not pagination.
 */
const RUNS_LIMIT = 50;

/**
 * How often the pane re-reads `GET /v0/runs`: there is a stream per root run, none for the set of
 * them, so polling is what catches a run launched from the CLI.
 */
export const RUNS_REFRESH_MS = 5000;

/** One `RunStatus`, or `"all"` for the unfiltered list. */
type StatusFilter = RunStatus | "all";

/** Stable empty affordance, so a rail that never opted in neither allocates per render nor branches. */
const EMPTY_RESUME_FROM: ResumeFromAffordance = {
  runs: new Map(),
  selectedRunId: null,
  rootFile: null,
  dirty: false,
};

export interface RunsListProps {
  client: PathApiClient;
  /**
   * Optional `workflow_id` scope (server-api-v0.md §3). `undefined` is the cross-workflow rail; a
   * string scopes to one workflow's history; `null` is a scoped surface with nothing open yet.
   */
  workflowId?: string | null;
  /** The run the app currently has selected — owned above, so the detail pane sees the same id. */
  selectedRootRunId: string | null;
  onSelectRootRun: (rootRunId: string) => void;
  /**
   * Switches the app to watch the successor of a resumed run — the same transition a launch makes.
   * The Resume affordance lives under the selected run's row.
   */
  onResumed: (successorRootRunId: string) => void;
  /**
   * Called after a run is deleted, so the app can drop the selection if it was watching that run and
   * force an immediate re-read.
   */
  onDeleted: (rootRunId: string) => void;
  reloadNonce?: number;
  /** The `Resume from …` K-selection affordance; omitted, the panel offers only Resume/Delete. */
  resumeFrom?: ResumeFromAffordance;
  /**
   * The watched run's published display status, keyed by run id, so a watched root whose leaf is
   * parked reads `awaiting` although its summary stays `running` (view-only, ADR 0038). Rows absent
   * from the map keep their summary status.
   */
  displayStatus?: ReadonlyMap<string, RunStatus>;
}

/** The runs-list read surface: root runs with status, read-only and formatting-only. */
export function RunsList({
  client,
  workflowId,
  selectedRootRunId,
  onSelectRootRun,
  onResumed,
  onDeleted,
  reloadNonce,
  resumeFrom,
  displayStatus,
}: RunsListProps) {
  // `null` (nothing open) never reaches a query — the effects short-circuit and the render is idle.
  const scope = typeof workflowId === "string" ? workflowId : undefined;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [state, setState] = useState<Load<RootRunSummary[]>>({ phase: "loading" });
  // The expanded row's action panel, or none. Independent of `selectedRootRunId`, so collapsing the
  // panel never stops the centre pane watching the run.
  const [openFor, setOpenFor] = useState<string | null>(null);

  // A ref, not a dependency: a launch re-reads the same window, and a filter change should not be a
  // reason for the nonce effect to re-read.
  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;

  useEffect(() => {
    if (workflowId === null) return;
    let cancelled = false;

    const read = (initial: boolean): void => {
      if (initial) setState({ phase: "loading" });
      client
        .listRuns({
          limit: RUNS_LIMIT,
          status: statusFilter === "all" ? undefined : statusFilter,
          workflowId: scope,
        })
        .then((res) => {
          if (!cancelled) setState({ phase: "ready", value: res.runs });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState({ phase: "error", message: errorMessage(error) });
        });
    };

    read(true);
    const timer = setInterval(() => read(false), RUNS_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, statusFilter, workflowId, scope]);

  // A launch bumps `reloadNonce`: re-read once, in place. Mount is skipped so this never doubles the
  // initial fetch; an unset `reloadNonce` opts out.
  const nonceStarted = useRef(false);
  useEffect(() => {
    if (reloadNonce === undefined) return;
    if (workflowId === null) return;
    if (!nonceStarted.current) {
      nonceStarted.current = true;
      return;
    }
    let cancelled = false;
    const status = statusFilterRef.current === "all" ? undefined : statusFilterRef.current;
    client
      .listRuns({ limit: RUNS_LIMIT, status, workflowId: scope })
      .then((res) => {
        if (!cancelled) setState({ phase: "ready", value: res.runs });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce, workflowId, scope]);

  // A scoped surface with nothing open: an idle note, no toolbar, no reads.
  if (workflowId === null) {
    return (
      <div className="runs-list">
        <p className="pane-note">Open a workflow to see its runs.</p>
      </div>
    );
  }

  return (
    <div className="runs-list">
      <div className="runs-toolbar">
        <label className="field-label" htmlFor="runs-status-filter">
          Status
        </label>
        <select
          id="runs-status-filter"
          className="field"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
        >
          <option value="all">all</option>
          {ORDERED_RUN_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        {/* With a capped window, "how many am I looking at" is not answerable by eye. */}
        {state.phase === "ready" && <span className="runs-count">{state.value.length}</span>}
      </div>

      {state.phase === "loading" && <PaneLoading what="runs" />}
      {state.phase === "error" && <PaneError what="runs" message={state.message} />}
      {state.phase === "ready" &&
        (state.value.length === 0 ? (
          // Two empty states: "No runs yet." is only true of an unfiltered list, and an operator who
          // narrowed the filter needs to know which of the two they hit.
          <p className="pane-note">
            {statusFilter === "all" ? "No runs yet." : `No ${statusFilter} runs.`}
          </p>
        ) : (
          <ul className="runs">
            {state.value.map((run) => {
              // The watched run shows its published display status, so a parked leaf reads `awaiting`;
              // rows with no tree behind them keep their summary.
              const rowStatus = displayStatus?.get(run.run_id) ?? run.status;
              // A live run offers no action: it cannot be resumed, and the server 409s a delete on it.
              const inFlight = rowStatus === "running" || rowStatus === "awaiting";
              // Plain Resume stays visible but greyed on a `succeeded` run, so its pairing with
              // `Resume from …` reads. The panel is a sibling of the row button, never inside it.
              const canResume = run.status === "cancelled" || run.status === "failed";
              const showResume = isTerminal(run.status);
              const open = openFor === run.run_id;
              // `Resume from …` needs a loaded tree, so only the watched run offers it — the one way back
              // into a succeeded run (rerun from a chosen boundary, ADR 0033).
              const showResumeFrom =
                resumeFrom !== undefined && run.run_id === selectedRootRunId && !inFlight;
              return (
                <li key={run.run_id}>
                  <button
                    type="button"
                    className="run-row"
                    title={run.run_id}
                    data-run-id={run.run_id}
                    data-testid={`run-row-${run.run_id}`}
                    aria-current={run.run_id === selectedRootRunId ? "true" : undefined}
                    aria-expanded={open}
                    onClick={() => {
                      onSelectRootRun(run.run_id);
                      // Single-open toggle: the same row closes it, another row moves it.
                      setOpenFor((current) => (current === run.run_id ? null : run.run_id));
                    }}
                  >
                    <span className="run-workflow">{run.workflow_name ?? "—"}</span>
                    <StatusPill status={rowStatus} />
                    <span className="run-id">{run.run_id}</span>
                    <span className="run-started">{formatTimestamp(run.started_at)}</span>
                  </button>
                  {open && (
                    <div className="run-actions" data-testid={`run-actions-${run.run_id}`}>
                      {inFlight ? (
                        <p className="pane-note">
                          This run is still in flight. Resume and delete become available once it
                          finishes.
                        </p>
                      ) : (
                        <>
                          {(showResume || showResumeFrom) && (
                            <ResumeActions
                              client={client}
                              rootRunId={run.run_id}
                              showResume={showResume}
                              plainResumable={canResume}
                              showResumeFrom={showResumeFrom}
                              resumeFrom={resumeFrom ?? EMPTY_RESUME_FROM}
                              // Masked launch secrets (ADR 0046), asked for before submit rather than
                              // letting the engine refuse the resume.
                              launchSecretKeys={run.launch_secret_keys}
                              onResumed={(successorRootRunId) => {
                                setOpenFor(null);
                                onResumed(successorRootRunId);
                              }}
                            />
                          )}
                          <DeleteButton
                            client={client}
                            run={run}
                            onDeleted={(deletedRootRunId) => {
                              setOpenFor(null);
                              onDeleted(deletedRootRunId);
                            }}
                          />
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}
