import type { PathApiClient } from "@path/client-core";
import { useState } from "react";
import { JsonField } from "./json-field.js";
import { parseJsonField } from "@path/client-core";
import { errorMessage } from "./load-state.js";

export interface ResumeButtonProps {
  client: PathApiClient;
  rootRunId: string;
  /** Handed the successor's fresh root run id so the app can switch to watching it (same transition as a launch). */
  onResumed: (successorRootRunId: string) => void;
}

type Phase = "idle" | "sending";

/**
 * Resume a `cancelled`/`failed` root run as a successor (server-api-v0.md §4.3), the console's second
 * write verb after cancel (#56). One click, unlike cancel's two-step arm: resuming is a deliberate
 * recovery action rather than a destructive one, and the accidental-click cost cancel guards against
 * is inverted here — a stray resume starts a fresh paid run the operator sees and can cancel, whereas
 * a stray cancel destroys unrecoverable work with no undo.
 *
 * Under the button is an optional raw-JSON **config override** (the same field the launch form
 * offers): a resume restores its context from the predecessor, but the engine still applies operator
 * config on the resume path, so an operator can change a config value — an output path, a range —
 * before the remaining steps re-run. There is no `input` field: a resume discards input in favour of
 * the restored context (§4.3). An invalid config forces the field open and blocks the button, so the
 * reason is never off-screen.
 *
 * On success the parent switches to watching the successor (a fresh `running` root), so this button
 * unmounts on its own and there is no terminal phase to model. `"Resuming…"` is the request in
 * flight, not a run state.
 */
export function ResumeButton({ client, rootRunId, onResumed }: ResumeButtonProps) {
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
      // The app re-selects the successor, which unmounts this component — so no setState here, and no
      // post-unmount update to guard against.
      (res) => onResumed(res.root_run_id),
      (thrown: unknown) => {
        setPhase("idle");
        setError(errorMessage(thrown));
      },
    );
  };

  return (
    <div className="launch-form resume-form" data-testid="resume-form">
      <button
        type="button"
        className="launch-disclosure"
        data-testid="resume-config-toggle"
        aria-expanded={configOpen}
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

      <div className="launch-actions">
        <button
          type="button"
          className="launch-submit"
          data-testid="resume-button"
          disabled={!canResume}
          onClick={send}
        >
          {phase === "sending" ? "Resuming…" : "Resume run"}
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
