import {
  parseJsonField,
  resumeFromEligibility,
  type PathApiClient,
  type RunNodeState,
  type WorkflowFile,
} from "@path/client-core";
import { useState } from "react";
import { JsonField } from "./json-field.js";
import { errorMessage } from "./load-state.js";

export interface ResumeActionsProps {
  client: PathApiClient;
  /** The selected root run — the run being resumed / reran. */
  rootRunId: string;
  /**
   * Show the plain **`Resume run`** button. `true` for any finished run; a still-running run gets no
   * plain Resume at all (the panel never mounts these actions for it).
   */
  showResume: boolean;
  /**
   * The run's status permits a plain resume — `true` only for a `cancelled`/`failed` run. A
   * `succeeded` run leaves this `false`: the button stays visible but greyed, its reason inline, and
   * the way back in is `Resume from …` instead.
   */
  plainResumable: boolean;
  /**
   * Show the **`Resume from …`** K-selection button. `true` only in the watched run's own panel — the
   * one row with a loaded tree behind it — when the surface opted in by passing a tree.
   */
  showResumeFrom: boolean;
  /** The watched run's tree, keyed by run id — the same map the run tree renders; K is a row of it. */
  runs: ReadonlyMap<string, RunNodeState>;
  /** The open buffer's parsed file for the eager legal-K check (the Designer); the Viewer passes `null`. */
  rootFile: WorkflowFile | null;
  /** The run selected in the run tree; K is this run. `null` when nothing (or the root) is selected. */
  selectedRunId: string | null;
  /** The open buffer's dirty flag — the Designer's save-first gate (ADR 0030). The Viewer passes `false`. */
  dirty: boolean;
  /** Handed the successor's fresh root run id so the app can switch to watching it (as a launch/resume). */
  onResumed: (successorRootRunId: string) => void;
}

type Phase = "idle" | "sending";
type ErrorState = { source: "resume" | "resume-from"; message: string } | null;

/**
 * The run's resume actions as one card: a single shared **`Override config (optional)`** field on top,
 * then the two resume verbs that both send it — plain **`Resume run`** (§4.3) and **`Resume from …`**
 * (K-selection, ADR 0033) — each with its disabled reason on the same line as its button.
 *
 * Both verbs post the same `POST …/resume` with the same operator config; the only difference is the
 * `rerun_from_run_id` a `Resume from …` carries (K's run id). So the config override is one field, not
 * one per button — a value typed once is the value both would send. The field shows always and is
 * disabled only while **both** verbs are disabled (nothing to configure); an invalid config still
 * forces it open so its lint is never off-screen, and blocks both buttons.
 *
 * `Resume from …` legality is the client mirror `resumeFromEligibility` (the engine's one legal-K
 * rule); the engine's `refusal` stays the authority for a race and lands as the error alert. Resume
 * reads the file only — no edit-lock lease (ADR 0017).
 */
export function ResumeActions({
  client,
  rootRunId,
  showResume,
  plainResumable,
  showResumeFrom,
  runs,
  rootFile,
  selectedRunId,
  dirty,
  onResumed,
}: ResumeActionsProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [config, setConfig] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [error, setError] = useState<ErrorState>(null);

  const configResult = parseJsonField(config, { allowEmpty: true });

  // `Resume from …` legality — computed only when the button is shown (only then is a tree behind it).
  const eligibility = showResumeFrom
    ? resumeFromEligibility({ rootRunId, runs, rootFile, selectedRunId, dirty })
    : null;

  // "Enabled" here is by status / K-eligibility alone, not config validity — a bad config must not lock
  // the config field it lives in. The field is disabled only when neither verb is enabled by status.
  const resumeEnabledByStatus = showResume && plainResumable;
  const resumeFromEnabledByStatus = eligibility?.ok === true;
  const configDisabled = !resumeEnabledByStatus && !resumeFromEnabledByStatus;
  // Collapsed while disabled (nothing to set); otherwise the launch form's rule — open on demand, and
  // forced open on an invalid value so the reason is never hidden behind a collapsed disclosure.
  const configOpen = !configDisabled && (showConfig || !configResult.ok);

  const canResume = resumeEnabledByStatus && configResult.ok && phase !== "sending";
  const canResumeFrom = resumeFromEnabledByStatus && configResult.ok && phase !== "sending";

  const sendResume = (): void => {
    if (!configResult.ok) return;
    setError(null);
    setPhase("sending");
    client.resumeRun(rootRunId, configResult.value).then(
      (res) => onResumed(res.root_run_id),
      (thrown: unknown) => {
        setPhase("idle");
        setError({ source: "resume", message: errorMessage(thrown) });
      },
    );
  };

  const sendResumeFrom = (): void => {
    if (eligibility === null || !eligibility.ok || !configResult.ok) return;
    setError(null);
    setPhase("sending");
    client.resumeRun(rootRunId, configResult.value, eligibility.runId).then(
      (res) => onResumed(res.root_run_id),
      (thrown: unknown) => {
        setPhase("idle");
        setError({ source: "resume-from", message: errorMessage(thrown) });
      },
    );
  };

  // The greyed plain-Resume's inline reason: a finished-but-succeeded run reruns from a chosen
  // boundary, it does not plain-resume. Shown only when the button is present and status-disabled.
  const resumeReason =
    showResume && !plainResumable
      ? "Succeeded — rerun from a chosen boundary below."
      : null;

  return (
    <div className="launch-form resume-form" data-testid="resume-form">
      <button
        type="button"
        className="launch-disclosure"
        data-testid="resume-config-toggle"
        aria-expanded={configOpen}
        disabled={configDisabled}
        onClick={() => setShowConfig((shown) => !shown)}
      >
        {configOpen ? "▾" : "▸"} Override config (optional)
        {config.trim() !== "" && <span className="launch-disclosure-dot"> · set</span>}
      </button>
      {configOpen && (
        <JsonField
          id={`resume-config-${rootRunId}`}
          testId="resume-config"
          label="config override · JSON"
          value={config}
          onChange={setConfig}
          result={configResult}
          rows={3}
          placeholder='{"output_file": "…"}'
        />
      )}

      {showResume && (
        <div className="resume-line">
          <button
            type="button"
            className="launch-submit"
            data-testid="resume-button"
            disabled={!canResume}
            onClick={sendResume}
          >
            {phase === "sending" ? "Resuming…" : "Resume run"}
          </button>
          {resumeReason !== null && (
            <span className="resume-reason" data-testid="resume-reason" role="note">
              {resumeReason}
            </span>
          )}
        </div>
      )}

      {showResumeFrom && eligibility !== null && (
        <div className="resume-line">
          <button
            type="button"
            className="launch-submit resume-from-submit"
            data-testid="resume-from-submit"
            disabled={!canResumeFrom}
            // K's identity (node name + full run id) is the hover title on an enabled K; on a disabled
            // one the title is the reason, which also shows inline beside the button.
            title={eligibility.ok ? `Resume from ${eligibility.nodeName} (${eligibility.runId})` : eligibility.message}
            onClick={sendResumeFrom}
          >
            {phase === "sending"
              ? "Resuming…"
              : eligibility.ok
                ? `Resume from ${eligibility.nodeName}(${eligibility.shortRunId})`
                : "Resume from …"}
          </button>
          {!eligibility.ok && (
            <span className="resume-reason" data-testid="resume-from-reason" role="note">
              {eligibility.message}
            </span>
          )}
        </div>
      )}

      {error !== null && (
        <p
          className="pane-note pane-error launch-error"
          data-testid={error.source === "resume-from" ? "resume-from-error" : "resume-error"}
          role="alert"
        >
          {error.message}
        </p>
      )}
    </div>
  );
}
