import type { PathApiClient, RootRunSummary, RunStatus } from "@path/client-core";
import { useEffect, useRef, useState } from "react";
import { formatTimestamp } from "./format-time.js";
import { errorMessage, type Load } from "./load-state.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { DeleteButton } from "./delete-button.js";
import { ResumeButton } from "./resume-button.js";
import { ORDERED_RUN_STATUSES } from "./status-glyph.js";
import { StatusPill } from "./status-pill.js";

/**
 * How many root runs the pane asks for. `GET /v0/runs` is most-recent-first (server-api-v0.md §3),
 * so this is a "latest N" window, not pagination — the viewer is a monitor, and paging back through
 * run history is not one of its four read surfaces (map #40). Sent explicitly (it happens to equal
 * the server's own default) so the window the pane renders is the window the pane asked for.
 */
const RUNS_LIMIT = 50;

/**
 * How often the pane re-reads `GET /v0/runs` (#50). The list is the one surface with no live feed
 * behind it — there is a stream per root run, none for the set of them — so a periodic re-read is
 * what keeps the rail from contradicting the live centre pane, or missing a run launched from the
 * CLI while the page was open. Seconds, not milliseconds: a status settling a moment late costs
 * nothing, and this is a monitor, not a dashboard people stare at.
 */
export const RUNS_REFRESH_MS = 5000;

/** The pane's status filter: one `RunStatus`, or `"all"` for the unfiltered list. */
type StatusFilter = RunStatus | "all";

export interface RunsListProps {
  client: PathApiClient;
  /** The run the app currently has selected — owned above, so the detail pane sees the same id. */
  selectedRootRunId: string | null;
  onSelectRootRun: (rootRunId: string) => void;
  /**
   * Switches the app to watch the successor of a resumed run — the same transition a launch makes.
   * The Resume affordance lives here, under the selected run's row, mirroring how the launch form
   * expands under a workflow row: a run is resumed from the same rail it is selected in.
   */
  onResumed: (successorRootRunId: string) => void;
  /**
   * Called after a run is deleted (its row's Delete affordance), so the app can drop the selection if
   * it was watching that run and force an immediate re-read — the delete's mirror of {@link onResumed}.
   */
  onDeleted: (rootRunId: string) => void;
  /**
   * Bumped by the app after an inline launch (#233) to force an immediate re-read, so the run just
   * started appears in the rail now rather than at the next {@link RUNS_REFRESH_MS} tick — the same
   * one-shot read, triggered a beat early.
   */
  reloadNonce?: number;
}

/**
 * The runs-list read surface (issue #46): root runs with status, the left pane of the pinned
 * three-pane console (#44 Variant A). Read-only — no launch or edit affordances (map #40) — and
 * formatting-only: `@path/client-core` owns the wire shapes, this renders them.
 */
export function RunsList({
  client,
  selectedRootRunId,
  onSelectRootRun,
  onResumed,
  onDeleted,
  reloadNonce,
}: RunsListProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [state, setState] = useState<Load<RootRunSummary[]>>({ phase: "loading" });
  // Which row's action panel is expanded, or none — a single-open toggle exactly like the launch
  // form's `expanded` (launch-panel.tsx): clicking a row opens its panel, clicking it again closes
  // it, clicking another row moves the expand there. Independent of `selectedRootRunId`, so
  // collapsing the panel never stops the centre pane watching the run.
  const [openFor, setOpenFor] = useState<string | null>(null);

  // The current filter, read by the nonce effect without making it a dependency: a launch re-reads
  // the same window the pane is showing, and should not itself be a reason to re-read on filter change.
  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;

  useEffect(() => {
    let cancelled = false;

    // A refresh replaces the rows in place: no `loading` phase, so an already-rendered list never
    // flashes back to "Loading runs…" every few seconds. A *failing* refresh does surface — a frozen
    // list that still looks healthy is the worse lie.
    const read = (initial: boolean): void => {
      if (initial) setState({ phase: "loading" });
      client
        .listRuns({ limit: RUNS_LIMIT, status: statusFilter === "all" ? undefined : statusFilter })
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
  }, [client, statusFilter]);

  // A launch (#233) bumps `reloadNonce`; re-read once, in place — no loading flash, because the rail
  // is already populated and only one row is being added. The first run (mount) is skipped so this
  // never doubles the initial fetch above; an unset `reloadNonce` opts out entirely.
  const nonceStarted = useRef(false);
  useEffect(() => {
    if (reloadNonce === undefined) return;
    if (!nonceStarted.current) {
      nonceStarted.current = true;
      return;
    }
    let cancelled = false;
    const status = statusFilterRef.current === "all" ? undefined : statusFilterRef.current;
    client
      .listRuns({ limit: RUNS_LIMIT, status })
      .then((res) => {
        if (!cancelled) setState({ phase: "ready", value: res.runs });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce]);

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

      {state.phase === "loading" && <PaneLoading what="runs" />}
      {state.phase === "error" && <PaneError what="runs" message={state.message} />}
      {state.phase === "ready" &&
        (state.value.length === 0 ? (
          // Two empty states, not one: "No runs yet." is only true of an unfiltered list, and an
          // operator who has just narrowed the filter needs to know which of the two they hit.
          <p className="pane-note">
            {statusFilter === "all" ? "No runs yet." : `No ${statusFilter} runs.`}
          </p>
        ) : (
          <ul className="runs">
            {state.value.map((run) => {
              // Every row expands an action panel under itself — the rail's mirror of the launch form
              // under a workflow row (#233). The panel always offers Delete; a finished-but-unsuccessful
              // run also offers Resume. Rendered as a sibling of the row button, never inside it (a
              // button cannot nest the panel's own buttons).
              const canResume = run.status === "cancelled" || run.status === "failed";
              const open = openFor === run.run_id;
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
                      // Toggle this row's action panel, single-open, like the launch form.
                      setOpenFor((current) => (current === run.run_id ? null : run.run_id));
                    }}
                  >
                    <span className="run-workflow">{run.workflow_name ?? "—"}</span>
                    <StatusPill status={run.status} />
                    <span className="run-id">{run.run_id}</span>
                    <span className="run-started">{formatTimestamp(run.started_at)}</span>
                  </button>
                  {open && (
                    <div className="run-actions" data-testid={`run-actions-${run.run_id}`}>
                      {canResume && (
                        <ResumeButton
                          client={client}
                          rootRunId={run.run_id}
                          onResumed={(successorRootRunId) => {
                            // Collapse on success, as the launch form does on launch — then hand the
                            // successor to the app to select and watch.
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
