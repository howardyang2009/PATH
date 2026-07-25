import type { PathApiClient, RootRunSummary, RunStatus } from "@path/client-core";
import { useEffect, useState } from "react";
import { formatTimestamp } from "./format-time.js";
import { errorMessage, type Load } from "./load-state.js";
import { ORDERED_RUN_STATUSES } from "./status-glyph.js";
import { StatusPill } from "./status-pill.js";

/**
 * How many root runs the pane asks for. `GET /v0/runs` is most-recent-first (server-api-v0.md §3),
 * so this is a "latest N" window, not pagination — the viewer is a monitor, and paging back through
 * run history is not one of its four read surfaces (map #40). Sent explicitly (it happens to equal
 * the server's own default) so the window the pane renders is the window the pane asked for.
 */
const RUNS_LIMIT = 50;

/** The pane's status filter: one `RunStatus`, or `"all"` for the unfiltered list. */
type StatusFilter = RunStatus | "all";

export interface RunsListProps {
  client: PathApiClient;
  /** The run the app currently has selected — owned above, so the detail pane sees the same id. */
  selectedRootRunId: string | null;
  onSelectRootRun: (rootRunId: string) => void;
}

/**
 * The runs-list read surface (issue #46): root runs with status, the left pane of the pinned
 * three-pane console (#44 Variant A). Read-only — no launch or edit affordances (map #40) — and
 * formatting-only: `@path/client-core` owns the wire shapes, this renders them.
 */
export function RunsList({ client, selectedRootRunId, onSelectRootRun }: RunsListProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [state, setState] = useState<Load<RootRunSummary[]>>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    client
      .listRuns({ limit: RUNS_LIMIT, status: statusFilter === "all" ? undefined : statusFilter })
      .then((res) => {
        if (!cancelled) setState({ phase: "ready", value: res.runs });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ phase: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, statusFilter]);

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
        {/* The row count, as in the #44 prototype's pane header: with a capped window, "how many am
            I looking at" is not answerable by eye. */}
        {state.phase === "ready" && <span className="runs-count">{state.value.length}</span>}
      </div>

      {state.phase === "loading" && <p className="pane-note">Loading runs…</p>}
      {state.phase === "error" && (
        <p className="pane-note pane-error" role="alert">
          Failed to load runs: {state.message}
        </p>
      )}
      {state.phase === "ready" &&
        (state.value.length === 0 ? (
          // Two empty states, not one: "No runs yet." is only true of an unfiltered list, and an
          // operator who has just narrowed the filter needs to know which of the two they hit.
          <p className="pane-note">
            {statusFilter === "all" ? "No runs yet." : `No ${statusFilter} runs.`}
          </p>
        ) : (
          <ul className="runs">
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
                  <span className="run-id">{run.run_id}</span>
                  <StatusPill status={run.status} />
                  <span className="run-started">{formatTimestamp(run.started_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
