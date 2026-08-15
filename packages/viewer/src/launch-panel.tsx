import type { PathApiClient, WorkflowSummary } from "@path/client-core";
import { useEffect, useState } from "react";
import { parseJsonField } from "./launch-json.js";
import { errorMessage, type Load } from "./load-state.js";
import { PaneError, PaneLoading } from "./pane-note.js";

export interface LaunchPanelProps {
  client: PathApiClient;
  /** Called with the new run's `root_run_id` once a launch is accepted (202) — the app selects it. */
  onLaunched: (rootRunId: string) => void;
}

/**
 * The launch surface (issue #233, part of #228): the pinned three-pane console's left column gains
 * a workflow list above the runs list, and launching happens **inline** — a valid workflow row
 * expands a raw-JSON launch form under itself (prototype variant A, the chosen placement). Discovery
 * is `GET /v0/workflows` (§6): every discovered file, roots flagged, invalid ones shown but not
 * launchable. A launch is `POST /v0/runs` (§2); its `202 {root_run_id}` is lifted to the app, which
 * selects the run so the centre pane streams it live.
 *
 * One-shot read, not a refresh loop like the runs list: discovery is a fresh filesystem scan with no
 * live feed behind it, and workflow files change on an author's timescale, not a run's — a reload
 * re-scans. The runs list next to it owns the periodic re-read.
 */
export function LaunchPanel({ client, onLaunched }: LaunchPanelProps) {
  const [state, setState] = useState<Load<WorkflowSummary[]>>({ phase: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listWorkflows()
      .then((res) => {
        if (!cancelled) setState({ phase: "ready", value: res.workflows });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div className="launch-panel">
      <div className="launch-head">
        <span className="field-label">Workflows</span>
        {state.phase === "ready" && <span className="runs-count">{state.value.length}</span>}
      </div>

      {state.phase === "loading" && <PaneLoading what="workflows" />}
      {state.phase === "error" && <PaneError what="workflows" message={state.message} />}
      {state.phase === "ready" &&
        (state.value.length === 0 ? (
          <p className="pane-note">No workflows found.</p>
        ) : (
          <ul className="workflows">
            {state.value.map((workflow) => (
              <li key={workflow.relative_path}>
                <WorkflowRow
                  workflow={workflow}
                  expanded={expanded === workflow.relative_path}
                  onToggle={() =>
                    setExpanded((current) =>
                      current === workflow.relative_path ? null : workflow.relative_path,
                    )
                  }
                />
                {expanded === workflow.relative_path && (
                  <LaunchForm
                    key={workflow.relative_path}
                    client={client}
                    workflow={workflow}
                    onLaunched={(rootRunId) => {
                      setExpanded(null);
                      onLaunched(rootRunId);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/** One workflow in the list: a launch trigger when valid, a labelled dead row (with its load error) when not. */
function WorkflowRow({
  workflow,
  expanded,
  onToggle,
}: {
  workflow: WorkflowSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = (
    <>
      <span className="workflow-name">{workflow.name ?? "—"}</span>
      <span className="workflow-path">{workflow.relative_path}</span>
    </>
  );

  // An invalid file cannot be launched (§6: `valid` is a load result, and a launch would 400 on the
  // same load) — so it is shown for triage, with its error, but is not an actionable control.
  if (!workflow.valid) {
    return (
      <div className="workflow-row workflow-row--invalid" data-testid={`workflow-row-${workflow.relative_path}`}>
        <span className="workflow-label">{label}</span>
        <RootTag workflow={workflow} />
        {workflow.error && <span className="workflow-error">{workflow.error.message}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="workflow-row"
      data-testid={`workflow-row-${workflow.relative_path}`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="workflow-label">{label}</span>
      <RootTag workflow={workflow} />
    </button>
  );
}

/** The root/nested/invalid flag from `is_root` (§6): a dedupe hint, not a launchability gate. */
function RootTag({ workflow }: { workflow: WorkflowSummary }) {
  if (!workflow.valid) return <span className="workflow-tag workflow-tag--invalid">invalid</span>;
  return workflow.is_root ? (
    <span className="workflow-tag workflow-tag--root">root</span>
  ) : (
    <span className="workflow-tag workflow-tag--nested">nested</span>
  );
}

type Submit = { phase: "idle" } | { phase: "sending" } | { phase: "error"; message: string };

/**
 * The inline launch form under an expanded workflow row (#233 variant A). Raw JSON for `input`
 * (prefilled `{}`, empty allowed — the format declares no input schema) and, behind a disclosure,
 * an optional `config` override. Client-side JSON is gated by {@link parseJsonField}; the server is
 * still the validator, and its `400` (schema failure, a rejected `$env` override — ADR 0012) lands
 * back here as an alert without collapsing the form, so the operator can fix the body and retry.
 */
function LaunchForm({
  client,
  workflow,
  onLaunched,
}: {
  client: PathApiClient;
  workflow: WorkflowSummary;
  onLaunched: (rootRunId: string) => void;
}) {
  const [input, setInput] = useState("{}");
  const [config, setConfig] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });

  // Config is always parsed from its own text, not gated on `showConfig`: a value the operator typed
  // is a value they meant to send, whether or not the disclosure happens to be open, and gating on
  // visibility would silently drop an override on launch. The disclosure only shows/hides the field.
  const inputResult = parseJsonField(input, { allowEmpty: true });
  const configResult = parseJsonField(config, { allowEmpty: true });
  const canLaunch = inputResult.ok && configResult.ok && submit.phase !== "sending";
  // An invalid config cannot hide behind a collapsed disclosure — that would disable Launch with the
  // reason off-screen — so a bad config forces the field open.
  const configOpen = showConfig || !configResult.ok;

  const launch = (): void => {
    if (!inputResult.ok || !configResult.ok) return;
    setSubmit({ phase: "sending" });
    client
      .startRun({
        workflowPath: workflow.relative_path,
        input: inputResult.value,
        config: configResult.value,
      })
      .then((res) => onLaunched(res.root_run_id))
      .catch((error: unknown) => setSubmit({ phase: "error", message: errorMessage(error) }));
  };

  return (
    <div className="launch-form" data-testid={`launch-form-${workflow.relative_path}`}>
      <JsonField
        id={`launch-input-${workflow.relative_path}`}
        testId="launch-input"
        label="input · JSON"
        value={input}
        onChange={setInput}
        result={inputResult}
        rows={4}
      />

      <button
        type="button"
        className="launch-disclosure"
        data-testid="launch-config-toggle"
        aria-expanded={configOpen}
        onClick={() => setShowConfig((shown) => !shown)}
      >
        {configOpen ? "▾" : "▸"} Override config (optional)
        {config.trim() !== "" && <span className="launch-disclosure-dot"> · set</span>}
      </button>
      {configOpen && (
        <JsonField
          id={`launch-config-${workflow.relative_path}`}
          testId="launch-config"
          label="config override · JSON"
          value={config}
          onChange={setConfig}
          result={configResult}
          rows={3}
          placeholder='{"model": "…", "$secret": {"name": "…"}}'
        />
      )}

      <div className="launch-actions">
        <button
          type="button"
          className="launch-submit"
          data-testid="launch-submit"
          disabled={!canLaunch}
          onClick={launch}
        >
          {submit.phase === "sending" ? "Launching…" : `Launch ${workflow.name ?? "workflow"}`}
        </button>
      </div>

      {submit.phase === "error" && (
        <p className="pane-note pane-error launch-error" data-testid="launch-error" role="alert">
          {submit.message}
        </p>
      )}
    </div>
  );
}

/** One raw-JSON textarea with its live client-side lint line, shared by the input and config fields. */
function JsonField({
  id,
  testId,
  label,
  value,
  onChange,
  result,
  rows,
  placeholder,
}: {
  id: string;
  testId: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  result: ReturnType<typeof parseJsonField>;
  rows: number;
  placeholder?: string;
}) {
  const hint = result.ok ? (result.empty ? "empty — field omitted" : "valid JSON") : result.message;
  return (
    <div className="launch-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        data-testid={testId}
        className="launch-textarea"
        value={value}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={result.ok ? undefined : true}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className={`launch-lint${result.ok ? "" : " launch-lint--bad"}`}>{hint}</p>
    </div>
  );
}
