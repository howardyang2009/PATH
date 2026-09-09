import {
  resumeFromEligibility,
  type PathApiClient,
  type RunNodeState,
  type WorkflowFile,
} from "@path/client-core";
import { parseJsonField } from "@path/client-core";
import { useState } from "react";
import { JsonField } from "./json-field.js";
import { errorMessage } from "./load-state.js";

export interface ResumeFromButtonProps {
  client: PathApiClient;
  /** The selected root run — the run being resumed. The button renders only when one is selected. */
  rootRunId: string;
  /** The watched run's tree, keyed by run id — the same map the run tree renders; K is a row of it. */
  runs: ReadonlyMap<string, RunNodeState>;
  /**
   * The open buffer's parsed file (the root level), or `null` when the surface holds no file. The
   * Designer passes its open buffer, so a top-level K is located in the file body — the eager legal-K
   * check; the Viewer holds no buffer and passes `null`, so only the run-tree-derivable reasons grey
   * eagerly and the engine's `refusal` backstops the rest on click (spec § Resume from here).
   */
  rootFile: WorkflowFile | null;
  /** The run selected in the run tree; K is this run. `null` when nothing (or the root) is selected. */
  selectedRunId: string | null;
  /** The open buffer's dirty flag — the Designer's save-first gate (ADR 0030). The Viewer passes `false`. */
  dirty: boolean;
  /** Handed the successor's fresh root run id so the app can switch to watching it (as a launch/resume). */
  onResumed: (successorRootRunId: string) => void;
}

type Phase = "idle" | "sending";

/**
 * The **`Resume from …`** run-action button (spec § Resume from here, ADR 0033) — the K-supplied case
 * of the one Resume action, shared by the Designer's run dock and the Viewer's run detail (both mount
 * the same run panels from `@path/viewer`). K is the **run** of the node the author selects in the run
 * tree (the only handle carrying a run id); the button is **always rendered** for a selected root run
 * and has exactly two states, enabled or disabled-with-one-reason.
 *
 * Legality is computed **eagerly**, client-side, by `resumeFromEligibility` (the client mirror of the
 * engine's one legal-K rule): the disabled reason follows the fixed precedence — (1) no node selected,
 * (2) an illegal K in the engine's taxonomy, (3) a legal K over a dirty buffer ("Save to enable"). The
 * engine's `refusal` stays the authority for a **race** (the file moved under the buffer) — it lands
 * here as the error alert, not a second gate. Resume reads the file only, so it takes **no** edit-lock
 * lease (ADR 0017).
 *
 * When enabled the label carries K's identity — `Resume from <node-name> (<short-run-id>)` — with the
 * full run id as the hover title and the `rerun_from_run_id` wire value. Under it is the same optional
 * config-override the launch/plain-resume forms offer: a resume restores its context from the
 * predecessor, but the engine still applies operator config on the steps that re-run.
 */
export function ResumeFromButton({
  client,
  rootRunId,
  runs,
  rootFile,
  selectedRunId,
  dirty,
  onResumed,
}: ResumeFromButtonProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [config, setConfig] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibility = resumeFromEligibility({ rootRunId, runs, rootFile, selectedRunId, dirty });

  // Config is parsed from its own text, not gated on the disclosure — a value the author typed is one
  // they meant to send. A bad config forces the field open (the launch/resume form's rule) so the
  // reason is never off-screen.
  const configResult = parseJsonField(config, { allowEmpty: true });
  const configOpen = showConfig || !configResult.ok;
  const canResume = eligibility.ok && configResult.ok && phase !== "sending";

  const send = (): void => {
    if (!eligibility.ok || !configResult.ok) return;
    setError(null);
    setPhase("sending");
    client.resumeRun(rootRunId, configResult.value, eligibility.runId).then(
      // The app re-selects the successor, which unmounts this component — so no post-unmount setState.
      (res) => onResumed(res.root_run_id),
      (thrown: unknown) => {
        // A server refusal (the race the engine owns, or a bad `$env` config) surfaces here without
        // collapsing the form, so the author can read it and retry.
        setPhase("idle");
        setError(errorMessage(thrown));
      },
    );
  };

  return (
    <div className="resume-from" data-testid="resume-from">
      {eligibility.ok && (
        <>
          <button
            type="button"
            className="launch-disclosure"
            data-testid="resume-from-config-toggle"
            aria-expanded={configOpen}
            onClick={() => setShowConfig((shown) => !shown)}
          >
            {configOpen ? "▾" : "▸"} Override config (optional)
            {config.trim() !== "" && <span className="launch-disclosure-dot"> · set</span>}
          </button>
          {configOpen && (
            <JsonField
              id="resume-from-config"
              testId="resume-from-config"
              label="config override · JSON"
              value={config}
              onChange={setConfig}
              result={configResult}
              rows={3}
              placeholder='{"output_file": "…"}'
            />
          )}
        </>
      )}

      <button
        type="button"
        className="launch-submit resume-from-submit"
        data-testid="resume-from-submit"
        disabled={!canResume}
        // The full run id is the hover title on an enabled K; on a disabled button the title is the
        // one reason, so the cause is reachable without reading the note line below.
        title={eligibility.ok ? eligibility.runId : eligibility.message}
        onClick={send}
      >
        {phase === "sending"
          ? "Resuming…"
          : eligibility.ok
            ? `Resume from ${eligibility.nodeName} (${eligibility.shortRunId})`
            : "Resume from …"}
      </button>

      {!eligibility.ok && (
        <p className="pane-note resume-from-reason" data-testid="resume-from-reason" role="note">
          {eligibility.message}
        </p>
      )}
      {error !== null && (
        <p className="pane-note pane-error launch-error" data-testid="resume-from-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
