import { parseJsonField, type PathApiClient } from "@path/client-core";
import { useState } from "react";
import { JsonField } from "./json-field.js";
import { errorMessage } from "./load-state.js";

export interface LaunchFormProps {
  client: PathApiClient;
  /**
   * The launch target — the file the server loads through `prepareWorkflow`. `null` means there is no
   * launchable target (the Designer's never-saved buffer); pair it with a `gate` that says why.
   */
  workflowPath: string | null;
  /** Called with the new run's `root_run_id` once a launch is accepted (202). */
  onLaunched: (rootRunId: string) => void;
  /** The submit button's label, e.g. `Launch my-flow` (Viewer) or `Run workflow` (Designer). */
  submitLabel: string;
  /** Base for the field `id`s (label `htmlFor` targets), unique per mounted form. */
  idBase: string;
  /** Prefix for the form's `data-testid`s: `${prefix}-input`, `-config`, `-submit`, `-error`, etc. */
  testIdPrefix: string;
  /** The outer container's `data-testid` (the Viewer keys it on the workflow path). */
  containerTestId: string;
  /**
   * An external disable reason (the Designer's save-first gate: an unsaved or dirty buffer). `null`
   * means no external gate. When set, the button is disabled and the reason shows under it.
   */
  gate?: string | null;
  /** Soft cross-node warning count (#388) — badges the button and notes below; never blocks. */
  warningCount?: number;
  /** The config field's placeholder JSON hint. */
  configPlaceholder?: string;
}

type Submit = { phase: "idle" } | { phase: "sending" } | { phase: "error"; message: string };

/**
 * The inline launch form: raw JSON `input` (prefilled `{}`, empty allowed — the format declares no
 * input schema) plus, behind a disclosure, an optional `config` override. Client-side JSON is gated by
 * {@link parseJsonField} (§ Shared seam); the server is still the validator, and its `400` (schema
 * failure, a rejected `$env` override — ADR 0012) lands back here as an alert **without collapsing the
 * form**, so the operator can fix the body and retry.
 *
 * Shared by the Viewer's launch panel (a picker over discovered workflows, #233) and the Designer's
 * run dock (the file open on the canvas, save-first — ADR 0025). The two surfaces differ only in what
 * they pass in: the Viewer supplies a valid workflow path and no gate; the Designer supplies its
 * save-first `gate` and soft `warningCount`, and passes `workflowPath: null` for a never-saved buffer.
 */
export function LaunchForm({
  client,
  workflowPath,
  onLaunched,
  submitLabel,
  idBase,
  testIdPrefix,
  containerTestId,
  gate = null,
  warningCount = 0,
  configPlaceholder = '{"model": "…", "$secret": {"name": "…"}}',
}: LaunchFormProps): JSX.Element {
  const [input, setInput] = useState("{}");
  const [config, setConfig] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });

  // Config is always parsed from its own text, not gated on `showConfig`: a value the operator typed
  // is a value they meant to send, whether or not the disclosure is open, and gating on visibility
  // would silently drop an override on launch. The disclosure only shows/hides the field.
  const inputResult = parseJsonField(input, { allowEmpty: true });
  const configResult = parseJsonField(config, { allowEmpty: true });
  // An invalid config cannot hide behind a collapsed disclosure — that would disable launch with the
  // reason off-screen — so a bad config forces the field open.
  const configOpen = showConfig || !configResult.ok;
  const canLaunch =
    gate === null &&
    workflowPath !== null &&
    inputResult.ok &&
    configResult.ok &&
    submit.phase !== "sending";

  const launch = (): void => {
    if (gate !== null || workflowPath === null || !inputResult.ok || !configResult.ok) return;
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
    <div className="launch-form" data-testid={containerTestId}>
      <JsonField
        id={`${idBase}-input`}
        testId={`${testIdPrefix}-input`}
        label="input · JSON"
        value={input}
        onChange={setInput}
        result={inputResult}
        rows={4}
      />

      <button
        type="button"
        className="launch-disclosure"
        data-testid={`${testIdPrefix}-config-toggle`}
        aria-expanded={configOpen}
        onClick={() => setShowConfig((shown) => !shown)}
      >
        {configOpen ? "▾" : "▸"} Override config (optional)
        {config.trim() !== "" && <span className="launch-disclosure-dot"> · set</span>}
      </button>
      {configOpen && (
        <JsonField
          id={`${idBase}-config`}
          testId={`${testIdPrefix}-config`}
          label="config override · JSON"
          value={config}
          onChange={setConfig}
          result={configResult}
          rows={3}
          placeholder={configPlaceholder}
        />
      )}

      <div className="launch-actions">
        <button
          type="button"
          className="launch-submit"
          data-testid={`${testIdPrefix}-submit`}
          disabled={!canLaunch}
          onClick={launch}
        >
          {submit.phase === "sending" ? "Launching…" : submitLabel}
          {warningCount > 0 && (
            <span className="run-warning-badge" data-testid={`${testIdPrefix}-warning-badge`}>
              ⚠ {warningCount}
            </span>
          )}
        </button>
      </div>

      {warningCount > 0 && gate === null && (
        <p className="run-warning" data-testid={`${testIdPrefix}-warning`} role="note">
          {warningCount} unresolved {warningCount === 1 ? "warning" : "warnings"} — the run may fail at start.
        </p>
      )}

      {gate !== null && (
        <p className="pane-note run-gate" data-testid={`${testIdPrefix}-gate`}>
          {gate}
        </p>
      )}
      {submit.phase === "error" && (
        <p
          className="pane-note pane-error launch-error"
          data-testid={`${testIdPrefix}-error`}
          role="alert"
        >
          {submit.message}
        </p>
      )}
    </div>
  );
}
