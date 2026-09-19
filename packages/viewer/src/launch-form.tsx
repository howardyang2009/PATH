import { parseJsonField, type PathApiClient, type WireStepPlugin } from "@path/client-core";
import { useState } from "react";
import { JsonField } from "./json-field.js";
import { errorMessage } from "./load-state.js";
import { WorkerDefaultsEditor, workerDefaultCandidates } from "./worker-defaults.js";

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
  /**
   * The step-plugin registry (`GET /v0/step-plugins`) the **launch worker-default** editor picks its
   * per-type choices from (ADR 0044). Empty by default — and the Designer's run dock passes
   * none, because the launch table is operator input authored in no file and its one editor is the
   * Viewer's operator surface. With no multi-worker type on offer the field is not rendered at all.
   */
  plugins?: readonly WireStepPlugin[];
}

type Submit = { phase: "idle" } | { phase: "sending" } | { phase: "error"; message: string };

/**
 * The inline launch form: raw JSON `input` (prefilled `{}`, empty allowed — the format declares no
 * input schema) and an optional `config` override, **each behind its own disclosure** — `input · JSON`
 * and `Override config (optional)`, both collapsed on first render — plus, when a registry with a
 * multi-worker type is supplied, the **launch worker-default** table (ADR 0044). Client-side JSON is
 * gated by {@link parseJsonField} (§ Shared seam); the server is still the validator, and its `400`
 * (schema failure, a rejected `$env` override — ADR 0012, a bad worker-default entry — ADR 0044) lands
 * back here as an alert **without collapsing the form**, so the operator can fix the body and retry.
 *
 * Shared by the Viewer's launch panel (a picker over discovered workflows, #233) and the Designer's
 * run dock (the file open on the canvas, save-first — ADR 0025). The two surfaces differ in what they
 * pass in: the Viewer supplies a valid workflow path, no gate, and the discovered step-plugin registry;
 * the Designer supplies its save-first `gate` and soft `warningCount`, passes `workflowPath: null` for
 * a never-saved buffer, and no registry — the launch worker-default is the operator's door (ADR 0044).
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
  plugins = [],
}: LaunchFormProps): JSX.Element {
  const [input, setInput] = useState("{}");
  const [config, setConfig] = useState("");
  // The launch worker-default table (ADR 0044): a `{ <type>: <worker-name> }` map, empty until the
  // operator adds a row. Its rows are constrained dropdowns, so no invalid entry can be authored here
  // and there is nothing to force open — the disclosure is the only state.
  const [workerDefaults, setWorkerDefaults] = useState<{ [type: string]: string }>({});
  const [showInput, setShowInput] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showWorkerDefaults, setShowWorkerDefaults] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });

  // Both fields are always parsed from their own text, not gated on their disclosure being open: a
  // value the operator typed is a value they meant to send, whether or not the field is visible, and
  // gating on visibility would silently drop an input or an override on launch. The disclosures only
  // show/hide the fields.
  const inputResult = parseJsonField(input, { allowEmpty: true });
  const configResult = parseJsonField(config, { allowEmpty: true });
  // An invalid value cannot hide behind a collapsed disclosure — that would disable launch with the
  // reason off-screen — so a bad value forces its own field open.
  const inputOpen = showInput || !inputResult.ok;
  const configOpen = showConfig || !configResult.ok;
  // Nothing to select when the registry ships no multi-worker type, so the field is not rendered at all.
  const hasWorkerChoices = workerDefaultCandidates(plugins).length > 0;
  const workerDefaultCount = Object.keys(workerDefaults).length;
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
      .startRun({
        workflowPath,
        input: inputResult.value,
        config: configResult.value,
        // An unset table is omitted, never sent as `{}` — the same "empty drops the key" rule the file
        // channel's `worker_defaults` follows (ADR 0044).
        workerDefaults: workerDefaultCount > 0 ? workerDefaults : undefined,
      })
      .then((res) => {
        setSubmit({ phase: "idle" });
        onLaunched(res.root_run_id);
      })
      .catch((error: unknown) => setSubmit({ phase: "error", message: errorMessage(error) }));
  };

  return (
    <div className="launch-form" data-testid={containerTestId}>
      {/* The disclosure is the input field's title, so the textarea is named by it (`labelledBy`)
          rather than printing the same words a second time as a field label. */}
      <button
        type="button"
        id={`${idBase}-input-toggle`}
        className="launch-disclosure"
        data-testid={`${testIdPrefix}-input-toggle`}
        aria-expanded={inputOpen}
        onClick={() => setShowInput((shown) => !shown)}
      >
        {inputOpen ? "▾" : "▸"} input · JSON
      </button>
      {inputOpen && (
        <JsonField
          id={`${idBase}-input`}
          testId={`${testIdPrefix}-input`}
          labelledBy={`${idBase}-input-toggle`}
          value={input}
          onChange={setInput}
          result={inputResult}
          rows={4}
        />
      )}

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

      {/* The launch worker-default (ADR 0044): a run-wide table sitting above every file's own
          `worker_defaults` and below a step's own `worker` pin. The disclosure names the section, so
          the editor inside prints no title of its own. */}
      {hasWorkerChoices && (
        <>
          <button
            type="button"
            className="launch-disclosure"
            data-testid={`${testIdPrefix}-worker-defaults-toggle`}
            aria-expanded={showWorkerDefaults}
            onClick={() => setShowWorkerDefaults((shown) => !shown)}
          >
            {showWorkerDefaults ? "▾" : "▸"} Launch worker defaults (optional)
            {workerDefaultCount > 0 && <span className="launch-disclosure-dot"> · set</span>}
          </button>
          {showWorkerDefaults && (
            <WorkerDefaultsEditor
              plugins={plugins}
              value={workerDefaults}
              onChange={setWorkerDefaults}
              hint="The worker each type's un-pinned steps use across this run. A per-type selection, not config: a step's own worker still wins, and this outranks the file's own default."
            />
          )}
        </>
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
