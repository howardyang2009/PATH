import { parseJsonField, type PathApiClient } from "@path/client-core";
import { useState } from "react";
import { JsonField } from "./json-field.js";
import { errorMessage } from "./load-state.js";

export interface RunLaunchProps {
  client: PathApiClient;
  /** The file open on the canvas — the launch target. `null` for a brand-new, never-saved buffer. */
  workflowPath: string | null;
  /** The active buffer's dirty flag: a launch runs the bytes on disk, so a dirty buffer gates it (ADR 0025). */
  dirty: boolean;
  /**
   * The open file's soft cross-node warning count (#388). Launch is **badged, not blocked**: a
   * saved-with-warnings file is clean, so launch is enabled; the count only tells the author the run
   * may surface the truth at run-start (an unresolved interpolation, an unset `$env`).
   */
  warningCount: number;
  /** Called with the new run's `root_run_id` once a launch is accepted (202) — the app watches it. */
  onLaunched: (rootRunId: string) => void;
}

type Submit = { phase: "idle" } | { phase: "sending" } | { phase: "error"; message: string };

/**
 * The launch surface (surface 2, ADR 0025), **save-first**. Unlike the Viewer's launch panel there is no
 * picker: the target is the file open on the canvas. A launch runs the **bytes on disk** — the server
 * loads `workflow_path` through `prepareWorkflow`, never the client's buffer — so:
 *
 * - **Launch is disabled while the buffer is dirty.** A dirty canvas must save (#371) first; the button
 *   says why, and enables once the buffer is clean.
 * - **A brand-new, unsaved workflow cannot launch** (no path for `prepareWorkflow` to load). Its first
 *   save creates the path, after which launch behaves as above.
 *
 * The form is the raw-JSON `input` (prefilled `{}`, empty allowed — the format declares no input schema)
 * plus an optional `config` override, gated client-side by `parseJsonField` (§ Shared seam). The server
 * is still the validator: its `400` (schema failure, a rejected `$env` override — ADR 0012) lands back
 * here as an alert **without collapsing the form**, so the author can fix the body and retry.
 */
export function RunLaunch({ client, workflowPath, dirty, warningCount, onLaunched }: RunLaunchProps): JSX.Element {
  const [input, setInput] = useState("{}");
  const [config, setConfig] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });

  // Config is always parsed from its own text, not gated on `showConfig`: a value the author typed is a
  // value they meant to send, whether or not the disclosure is open, and gating on visibility would
  // silently drop an override on launch. The disclosure only shows/hides the field.
  const inputResult = parseJsonField(input, { allowEmpty: true });
  const configResult = parseJsonField(config, { allowEmpty: true });
  // A bad config cannot hide behind a collapsed disclosure — that would block Launch with the reason
  // off-screen — so an invalid config forces the field open.
  const configOpen = showConfig || !configResult.ok;

  const unsaved = workflowPath === null;
  const gate = unsaved
    ? "Save this new workflow before you can run it."
    : dirty
      ? "Save your edits before you can run — a run uses the file on disk."
      : null;
  const canLaunch = gate === null && inputResult.ok && configResult.ok && submit.phase !== "sending";

  const launch = (): void => {
    if (workflowPath === null || dirty || !inputResult.ok || !configResult.ok) return;
    setSubmit({ phase: "sending" });
    client
      .startRun({ workflowPath, input: inputResult.value, config: configResult.value })
      .then((res) => {
        setSubmit({ phase: "idle" });
        onLaunched(res.root_run_id);
      })
      .catch((error: unknown) => setSubmit({ phase: "error", message: errorMessage(error) }));
  };

  return (
    <div className="run-launch" data-testid="run-launch">
      <JsonField
        id="run-launch-input"
        testId="run-launch-input"
        label="input · JSON"
        value={input}
        onChange={setInput}
        result={inputResult}
        rows={4}
      />

      <button
        type="button"
        className="run-disclosure"
        data-testid="run-launch-config-toggle"
        aria-expanded={configOpen}
        onClick={() => setShowConfig((shown) => !shown)}
      >
        {configOpen ? "▾" : "▸"} Override config (optional)
        {config.trim() !== "" && <span className="run-disclosure-dot"> · set</span>}
      </button>
      {configOpen && (
        <JsonField
          id="run-launch-config"
          testId="run-launch-config"
          label="config override · JSON"
          value={config}
          onChange={setConfig}
          result={configResult}
          rows={3}
          placeholder='{"model": "…", "$secret": {"name": "…"}}'
        />
      )}

      <div className="run-actions">
        <button
          type="button"
          className="run-submit"
          data-testid="run-launch-submit"
          disabled={!canLaunch}
          onClick={launch}
        >
          {submit.phase === "sending" ? "Launching…" : "Run workflow"}
          {warningCount > 0 && (
            <span className="run-warning-badge" data-testid="run-launch-warning-badge">
              ⚠ {warningCount}
            </span>
          )}
        </button>
      </div>

      {warningCount > 0 && gate === null && (
        <p className="run-warning" data-testid="run-launch-warning" role="note">
          {warningCount} unresolved {warningCount === 1 ? "warning" : "warnings"} — the run may fail at start.
        </p>
      )}

      {gate !== null && (
        <p className="run-note run-gate" data-testid="run-launch-gate">
          {gate}
        </p>
      )}
      {submit.phase === "error" && (
        <p className="run-note run-error" data-testid="run-launch-error" role="alert">
          {submit.message}
        </p>
      )}
    </div>
  );
}
