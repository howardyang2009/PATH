import type { PathApiClient, RootRunSummary, RunStatus } from "@path/client-core";
import { useEffect, useRef, useState } from "react";
import { formatTimestamp } from "./format-time.js";
import { errorMessage, type Load } from "./load-state.js";
import { ORDERED_RUN_STATUSES, RunStatusPill } from "./run-status.js";

/** A latest-N window past the `workflow_id` scope: full per-workflow history is a server-side filter (ADR 0025). */
const RUNS_LIMIT = 50;

/**
 * How often the list re-reads `GET /v0/runs` — the one run surface with no live feed behind it (there is
 * a stream per root run, none for the set of them). A periodic re-read keeps the rail from missing a run
 * launched elsewhere. Seconds, not milliseconds: a status settling a moment late costs nothing.
 */
export const RUNS_REFRESH_MS = 5000;

/** The list's status filter: one `RunStatus`, or `"all"`. */
type StatusFilter = RunStatus | "all";

export interface RunListProps {
  client: PathApiClient;
  /**
   * The open workflow's `id` — the scope key (ADR 0015 identity, not path), so a rename never splits the
   * history. `null` when nothing is open, or the buffer has no id yet; the list then shows an idle note.
   */
  workflowId: string | null;
  /** The run the app currently watches — owned above, so the inspector sees the same id. */
  selectedRootRunId: string | null;
  onSelectRootRun: (rootRunId: string) => void;
  /** Bumped by the app after a launch/resume to force an immediate re-read, so the new row appears now. */
  reloadNonce?: number;
}

/**
 * The run list (surface 5, ADR 0025): the open workflow's runs, **scoped by `workflow_id`**, full
 * history, most-recent-first. Not the Viewer's cross-workflow rail — a designer author watches one
 * workflow's history. Read-only and formatting-only: `@path/client-core` owns the wire shapes.
 */
export function RunList({ client, workflowId, selectedRootRunId, onSelectRootRun, reloadNonce }: RunListProps): JSX.Element {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [state, setState] = useState<Load<RootRunSummary[]>>({ phase: "loading" });

  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;

  useEffect(() => {
    // With nothing open there is no scope to read; the render shows the idle note and ignores `state`.
    if (workflowId === null) return;
    let cancelled = false;

    // A refresh replaces the rows in place: no `loading` phase, so a rendered list never flashes back to
    // "Loading…" every few seconds. A *failing* refresh does surface — a frozen list that still looks
    // healthy is the worse lie.
    const read = (initial: boolean): void => {
      if (initial) setState({ phase: "loading" });
      client
        .listRuns({ limit: RUNS_LIMIT, status: statusFilter === "all" ? undefined : statusFilter, workflowId })
        .then((res) => {
          if (!cancelled) setState({ phase: "ready", value: res.runs });
        })
        .catch((error: unknown) => {
          if (!cancelled) setState({ phase: "error", message: errorMessage(error) });
        });
    };

    read(true);
    const timer = setInterval(() => read(false), RUNS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, statusFilter, workflowId]);

  // A launch/resume bumps `reloadNonce`; re-read once, in place. The mount tick is skipped so this never
  // doubles the initial fetch; an unset `reloadNonce` opts out entirely.
  const nonceStarted = useRef(false);
  useEffect(() => {
    if (reloadNonce === undefined) return;
    if (!nonceStarted.current) {
      nonceStarted.current = true;
      return;
    }
    if (workflowId === null) return;
    let cancelled = false;
    const status = statusFilterRef.current === "all" ? undefined : statusFilterRef.current;
    client
      .listRuns({ limit: RUNS_LIMIT, status, workflowId })
      .then((res) => {
        if (!cancelled) setState({ phase: "ready", value: res.runs });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce, workflowId]);

  if (workflowId === null) {
    return <p className="run-note" data-testid="run-list-idle">Open a saved workflow to see its runs.</p>;
  }

  return (
    <div className="run-list" data-testid="run-list">
      <div className="run-list-toolbar">
        <label className="run-field-label" htmlFor="run-list-status-filter">
          Status
        </label>
        <select
          id="run-list-status-filter"
          className="run-select"
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
        {state.phase === "ready" && <span className="run-list-count">{state.value.length}</span>}
      </div>

      {state.phase === "loading" && <p className="run-note">Loading runs…</p>}
      {state.phase === "error" && (
        <p className="run-note run-error" role="alert">
          Failed to load runs: {state.message}
        </p>
      )}
      {state.phase === "ready" &&
        (state.value.length === 0 ? (
          <p className="run-note">
            {statusFilter === "all" ? "No runs of this workflow yet." : `No ${statusFilter} runs.`}
          </p>
        ) : (
          <ul className="run-rows">
            {state.value.map((run) => (
              <li key={run.run_id}>
                <button
                  type="button"
                  className="run-row"
                  title={run.run_id}
                  data-run-id={run.run_id}
                  data-testid={`run-row-${run.run_id}`}
                  aria-current={run.run_id === selectedRootRunId ? "true" : undefined}
                  onClick={() => onSelectRootRun(run.run_id)}
                >
                  <RunStatusPill status={run.status} />
                  <span className="run-row-id">{run.run_id}</span>
                  <span className="run-row-started">{formatTimestamp(run.started_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
