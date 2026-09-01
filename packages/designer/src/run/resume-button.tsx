import { parseJsonField, type PathApiClient } from "@path/client-core";
import { useState } from "react";
import { JsonField } from "./json-field.js";
import { errorMessage } from "./load-state.js";

export interface ResumeButtonProps {
  client: PathApiClient;
  rootRunId: string;
  /** Handed the successor's fresh root run id so the app can switch to watching it (same as a launch). */
  onResumed: (successorRootRunId: string) => void;
}

type Phase = "idle" | "sending";

/**
 * Resume a `cancelled`/`failed` root run as a successor (surface 4, ADR 0025). One click, unlike
 * cancel's two-step arm: resuming is a deliberate recovery, and the accidental-click cost cancel guards
 * against is inverted here — a stray resume starts a fresh paid run the author sees and can cancel.
 *
 * Under the button is an optional raw-JSON **config override** (the same field the launch form offers):
 * a resume restores its context from the predecessor, but the engine still applies operator config on
 * the resume path, so the author can change a config value before the remaining steps re-run. There is
 * no `input` field (a resume restores context from the predecessor).
 *
 * The **plan-reuse-across-edit caveat** (ADR 0025, normative as a warning): a resume matches nodes by
 * plan-reuse against the *predecessor's* plan, and after an edit the plan has moved — so a resume across
 * an edit reuses rows for nodes the author may have just changed. The Designer surfaces the warning and
 * lets the author judge; the plan-reuse semantics are the engine's existing contract (ADR 0001).
 */
export function ResumeButton({ client, rootRunId, onResumed }: ResumeButtonProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [config, setConfig] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configResult = parseJsonField(config, { allowEmpty: true });
  // A bad config can't hide behind a collapsed disclosure — that would disable Resume with the reason
  // off-screen — so an invalid config forces the field open (the launch form's rule).
  const configOpen = showConfig || !configResult.ok;
  const canResume = configResult.ok && phase !== "sending";

  const send = (): void => {
    if (!configResult.ok) return;
    setError(null);
    setPhase("sending");
    client.resumeRun(rootRunId, configResult.value).then(
      // The app re-selects the successor, which unmounts this component — so no post-unmount setState.
      (res) => onResumed(res.root_run_id),
      (thrown: unknown) => {
        setPhase("idle");
        setError(errorMessage(thrown));
      },
    );
  };

  return (
    <div className="run-resume" data-testid="run-resume">
      <p className="run-warning" data-testid="run-resume-caveat" role="note">
        Resume re-runs the remaining steps against the <em>previous</em> run's plan. If you edited the
        workflow since, it reuses rows for nodes you may have changed.
      </p>
      <button
        type="button"
        className="run-disclosure"
        data-testid="run-resume-config-toggle"
        aria-expanded={configOpen}
        onClick={() => setShowConfig((shown) => !shown)}
      >
        {configOpen ? "▾" : "▸"} Override config (optional)
        {config.trim() !== "" && <span className="run-disclosure-dot"> · set</span>}
      </button>
      {configOpen && (
        <JsonField
          id={`run-resume-config-${rootRunId}`}
          testId="run-resume-config"
          label="config override · JSON"
          value={config}
          onChange={setConfig}
          result={configResult}
          rows={3}
          placeholder='{"output_file": "…"}'
        />
      )}

      <div className="run-actions">
        <button
          type="button"
          className="run-submit"
          data-testid="run-resume-submit"
          disabled={!canResume}
          onClick={send}
        >
          {phase === "sending" ? "Resuming…" : "Resume run"}
        </button>
      </div>

      {error !== null && (
        <p className="run-note run-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
