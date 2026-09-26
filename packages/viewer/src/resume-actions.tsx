import {
  launchSecretResupply,
  type PathApiClient,
  type RunNodeState,
  resumeFromEligibility,
  resupplyGate,
  type WorkflowFile,
} from "@path/client-core";
import { useEffect, useState } from "react";
import { JsonField } from "./json-field.js";
import { errorMessage } from "./load-state.js";

/**
 * The four facts the eager legal-K check needs — the watched run's tree, the K selected in it, and the
 * open buffer's file and dirty flag (the Designer's save-first gate, ADR 0030). They are only meaningful
 * together, so a surface cannot pass a plausible-looking subset.
 */
export interface ResumeFromAffordance {
  /** The watched run's tree, keyed by run id; K is a row of it. */
  runs: ReadonlyMap<string, RunNodeState>;
  /** The run selected in the tree (K); `null` when nothing or the root is selected. */
  selectedRunId: string | null;
  /** The open buffer's parsed file for the eager legal-K check; the Viewer passes `null`. */
  rootFile: WorkflowFile | null;
  /** The open buffer's dirty flag (ADR 0030); the Viewer passes `false`. */
  dirty: boolean;
}

export interface ResumeActionsProps {
  client: PathApiClient;
  /** The selected root run — the run being resumed / reran. */
  rootRunId: string;
  /** Show the plain **`Resume run`** button; a still-running run gets no plain Resume at all. */
  showResume: boolean;
  /**
   * The run's status permits a plain resume — `true` only for `cancelled`/`failed`. A `succeeded` run
   * stays visible but greyed, with its reason inline.
   */
  plainResumable: boolean;
  /** Show **`Resume from …`**; only the watched run's own panel, with a loaded tree, opts in. */
  showResumeFrom: boolean;
  /** Everything the eager legal-K check reads. Required: the panel is only built with it. */
  resumeFrom: ResumeFromAffordance;
  /**
   * The root summary's `$secret`-masked config dot-paths (ADR 0046). Non-empty, the config field opens
   * prefilled: a masked `[secret:<key>]` token cannot continue the run.
   */
  launchSecretKeys?: readonly string[];
  /** Handed the successor's fresh root run id so the app can switch to watching it. */
  onResumed: (successorRootRunId: string) => void;
}

type Phase = "idle" | "sending";
type ErrorState = { source: "resume" | "resume-from"; message: string } | null;

/**
 * The run's resume actions as one card: a shared `Override config (optional)` field, then the two verbs
 * that both post it — plain `Resume run` (§4.3) and `Resume from …` (ADR 0033), which alone adds
 * `rerun_from_run_id`. Illegality mirrors the engine's `resumeFromEligibility`; the engine's refusal stays
 * authoritative for a race. Resume reads the file only — no edit-lock lease (ADR 0017).
 */
export function ResumeActions({
  client,
  rootRunId,
  showResume,
  plainResumable,
  showResumeFrom,
  resumeFrom,
  launchSecretKeys,
  onResumed,
}: ResumeActionsProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const secrets = launchSecretKeys ?? [];
  const resupply = launchSecretResupply(secrets);
  const showSecrets = resupply.required;
  // Prefilled from the summary's recorded secret paths; lazy init, so the skeleton is built once per mount.
  const [config, setConfig] = useState(() => resupply.skeleton);
  // A run with masked secrets opens the field by default so what must be re-entered is visible.
  const [showConfig, setShowConfig] = useState(showSecrets);
  const [error, setError] = useState<ErrorState>(null);

  // A new K-selection makes a prior action's refusal alert stale, so clear it on change.
  const selectedRunId = resumeFrom.selectedRunId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect's whole purpose is this reset.
  useEffect(() => {
    setError(null);
  }, [selectedRunId]);

  // The shared secret-restore gate (ADR 0046): a recorded secret is a credential the frozen config holds
  // only as a mask token, so both verbs stay disabled while one is blank — the engine would otherwise
  // continue with a key the operator did not choose. Derived from the text, not gated on a keystroke.
  const gate = resupplyGate(secrets, config, "resuming");
  const configResult = gate.configResult;
  const blankSecrets = gate.blankPaths;

  // `Resume from …` legality — computed only when the button is shown (only then is a tree behind it).
  const eligibility = showResumeFrom ? resumeFromEligibility({ rootRunId, ...resumeFrom }) : null;

  // Enabled by status/K alone, not config validity — a bad config must not lock the field it lives in.
  const resumeEnabledByStatus = showResume && plainResumable;
  const resumeFromEnabledByStatus = eligibility?.ok === true;
  const configDisabled = !resumeEnabledByStatus && !resumeFromEnabledByStatus;
  // Collapsed while disabled; otherwise open on demand, and forced open on an invalid value.
  const configOpen = !configDisabled && (showConfig || !configResult.ok);

  const canResume =
    resumeEnabledByStatus && configResult.ok && blankSecrets.length === 0 && phase !== "sending";
  const canResumeFrom =
    resumeFromEnabledByStatus &&
    configResult.ok &&
    blankSecrets.length === 0 &&
    phase !== "sending";

  // The one shared reason when the secret (not status or K) blocks both verbs; kept out of the per-button
  // reason lines so a failed run does not print the same sentence twice. A still-illegal K or a succeeded
  // run keeps its own button reason, which already disables it with nothing to fill in.
  const secretReason =
    gate.blockMessage !== null && (resumeEnabledByStatus || resumeFromEnabledByStatus)
      ? gate.blockMessage
      : null;

  const sendResume = (): void => {
    if (!configResult.ok || blankSecrets.length > 0) return;
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
    if (eligibility === null || !eligibility.ok || !configResult.ok || blankSecrets.length > 0)
      return;
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

  // The greyed plain-Resume's inline reason: a succeeded run reruns from a chosen boundary instead.
  const resumeReason =
    showResume && !plainResumable ? "Succeeded — rerun from a chosen boundary below." : null;

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
        <>
          <JsonField
            id={`resume-config-${rootRunId}`}
            testId="resume-config"
            label={
              showSecrets ? "Launch secrets (config override) · JSON" : "config override · JSON"
            }
            value={config}
            onChange={setConfig}
            result={configResult}
            rows={3}
            placeholder='{"output_file": "…"}'
          />
          {showSecrets && (
            <p className="pane-note" data-testid="resume-config-note">
              These launch secrets are stored masked and must be supplied again to resume.
            </p>
          )}
        </>
      )}

      {secretReason !== null && (
        <p
          className="pane-note pane-error resume-secret-error"
          role="alert"
          data-testid="resume-secret-error"
        >
          {secretReason}
        </p>
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
            // K's identity is the title on an enabled K; on a disabled one the title is the reason, which
            // also shows inline beside the button.
            title={
              eligibility.ok
                ? (secretReason ?? `Resume from ${eligibility.nodeName} (${eligibility.runId})`)
                : eligibility.message
            }
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
