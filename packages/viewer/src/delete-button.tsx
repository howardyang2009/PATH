import type { PathApiClient, RootRunSummary } from "@path/client-core";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { errorMessage } from "./load-state.js";

export interface DeleteButtonProps {
  client: PathApiClient;
  /** The run to delete — its identity is shown on the confirm step so the operator sees what
   * goes. */
  run: RootRunSummary;
  /** Called once the delete succeeds, so the parent can drop the selection and re-read the list. */
  onDeleted: (rootRunId: string) => void;
}

type Phase = "idle" | "confirming" | "sending";

/**
 * Delete a root run permanently — the console's destructive verb, expanded under a run row the way
 * Resume is. Unlike Resume (a one-click recovery), a delete removes the run's rows and blobs with
 * no undo, so it is two-step: the confirm step spells out exactly which run will go (its id and its
 * source workflow's name / id / file), and only the confirm sends. "Keep" returns to idle for free.
 *
 * On success the parent clears the selection and re-reads the list; a `409` (still running, or a
 * live successor reuses its data) or `404` (already gone) surfaces here as an alert without
 * collapsing the confirm, so the operator can read the reason.
 */
export function DeleteButton({ client, run, onDeleted }: DeleteButtonProps) {
  const t = useTranslations("shared");
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
            {t("deleteButton.arm")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="delete-form" data-testid="delete-form">
      <p className="delete-warning">{t("deleteButton.warning")}</p>
      <dl className="delete-identity" data-testid="delete-identity">
        <dt>{t("runFacts.rootRunId")}</dt>
        <dd className="run-id">{run.run_id}</dd>
        <dt>{t("runFacts.workflowName")}</dt>
        <dd>{run.workflow_name ?? "—"}</dd>
        <dt>{t("runFacts.workflowId")}</dt>
        <dd className="run-workflow-id">{run.workflow_id ?? "—"}</dd>
        <dt>{t("runFacts.workflowFile")}</dt>
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
          {t("deleteConfirm.keep")}
        </button>
        <button
          type="button"
          className="delete-confirm"
          data-testid="delete-confirm"
          disabled={phase === "sending"}
          onClick={send}
        >
          {phase === "sending" ? t("deleteConfirm.sending") : t("deleteConfirm.confirm")}
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
