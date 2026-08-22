import type { PathApiClient, RootRunSummary } from "@path/client-core";
import { useState } from "react";
import { errorMessage } from "./load-state.js";

export interface DeleteButtonProps {
  client: PathApiClient;
  /** The run to delete — its identity is shown on the confirm step so the operator sees what goes. */
  run: RootRunSummary;
  /** Called once the delete succeeds, so the parent can drop the selection and re-read the list. */
  onDeleted: (rootRunId: string) => void;
}

type Phase = "idle" | "confirming" | "sending";

/**
 * Delete a root run permanently — the console's destructive verb, expanded under a run row the way
 * Resume is (#56). Unlike Resume (a one-click recovery), a delete removes the run's rows and blobs
 * with no undo, so it is two-step: the first click arms a confirmation that spells out exactly which
 * run will go (its id and its source workflow's name / id / file), and only the confirm there sends
 * the request. The arm is reversible — "Keep" returns to idle — so a stray first click costs nothing.
 *
 * On success the parent clears the selection and re-reads the list, so the row disappears; a `409`
 * (still running, or a live successor reuses its data) or `404` (already gone) surfaces here as an
 * alert without collapsing the confirm, so the operator can read the reason.
 */
export function DeleteButton({ client, run, onDeleted }: DeleteButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const send = (): void => {
    setError(null);
    setPhase("sending");
    client.deleteRun(run.run_id).then(
      () => onDeleted(run.run_id),
      (thrown: unknown) => {
        setPhase("confirming");
        setError(errorMessage(thrown));
      },
    );
  };

  if (phase === "idle") {
    return (
      <div className="delete-form" data-testid="delete-form">
        <div className="launch-actions">
          <button
            type="button"
            className="delete-arm"
            data-testid="delete-arm"
            onClick={() => setPhase("confirming")}
          >
            Delete run…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="delete-form" data-testid="delete-form">
      <p className="delete-warning">Permanently delete this run's data from the database and blobs? This cannot be undone.</p>
      <dl className="delete-identity" data-testid="delete-identity">
        <dt>root run id</dt>
        <dd className="run-id">{run.run_id}</dd>
        <dt>workflow name</dt>
        <dd>{run.workflow_name ?? "—"}</dd>
        <dt>workflow id</dt>
        <dd className="run-workflow-id">{run.workflow_id ?? "—"}</dd>
        <dt>workflow file</dt>
        <dd className="run-workflow-path">{run.workflow_path ?? "—"}</dd>
      </dl>

      <div className="launch-actions">
        <button
          type="button"
          className="delete-cancel"
          data-testid="delete-keep"
          disabled={phase === "sending"}
          onClick={() => {
            setError(null);
            setPhase("idle");
          }}
        >
          Keep
        </button>
        <button
          type="button"
          className="delete-confirm"
          data-testid="delete-confirm"
          disabled={phase === "sending"}
          onClick={send}
        >
          {phase === "sending" ? "Deleting…" : "Confirm delete"}
        </button>
      </div>

      {error !== null && (
        <p className="pane-note pane-error launch-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
