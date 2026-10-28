import {
  credentialPlaceholder,
  type PathApiClient,
  readOverride,
  type WireStepPlugin,
} from "@path/client-core";
import type { Message } from "@path/i18n";
import { useMessage } from "@path/i18n/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { JsonField } from "./json-field.js";
import { errorMessage } from "./load-state.js";
import { WorkerDefaultsEditor, workerDefaultCandidates } from "./worker-defaults.js";

export interface LaunchFormProps {
  client: PathApiClient;
  /** The launch target — the file the server loads through `prepareWorkflow`. `null` means none. */
  workflowPath: string | null;
  /** Called with the new run's `root_run_id` once a launch is accepted (202). */
  onLaunched: (rootRunId: string) => void;
  /** The submit button's label, e.g. `Launch my-flow` (Viewer) or `Run workflow` (Designer). */
  submitLabel: string;
  /** Base for the field `id`s (label `htmlFor` targets), unique per mounted form. */
  idBase: string;
  /** Prefix for the form's `data-testid`s: `${prefix}-input`, `-config`, `-submit`, `-error`,
   * etc. */
  testIdPrefix: string;
  /** The outer container's `data-testid` (the Viewer keys it on the workflow path). */
  containerTestId: string;
  /** An external disable reason (the Designer's save-first gate); `null` means none. */
  gate?: Message | null;
  /** Soft cross-node warning count — badges the button and notes below; never blocks. */
  warningCount?: number;
  /** The config field's placeholder JSON hint. */
  configPlaceholder?: string;
  /**
   * The step-plugin registry the launch worker-default editor picks its per-type choices from
   * (ADR 0044). Empty, and with no multi-worker type on offer the field is not rendered at all.
   */
  plugins?: readonly WireStepPlugin[];
  /** The workers the workflow's own steps run on, when the surface knows them; their credentials
   * name the config placeholder. */
  workers?: readonly string[];
}

type Submit = { phase: "idle" } | { phase: "sending" } | { phase: "error"; message: string };

/**
 * The inline launch form: optional raw-JSON `input` and `config` overrides, each behind its own
 * collapsed disclosure, plus the launch worker-default table when a plugin registry offers a
 * multi-worker type (ADR 0044). Client-side JSON is gated by {@link readOverride}; the server is
 * still the validator, and its `400` lands back here as an alert **without collapsing the form**,
 * so the operator can retry.
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
  configPlaceholder = '{"model": "claude-sonnet-5-5", "CLAUDE_CODE_OAUTH_TOKEN": {"$secret": "sk-ant-oat01-…"}}',
  plugins = [],
  workers = [],
}: LaunchFormProps): JSX.Element {
  const t = useTranslations("shared");
  const renderMessage = useMessage();
  const [input, setInput] = useState("{}");
  const [config, setConfig] = useState("");
  // The launch worker-default table: a `{ <type>: <worker-name> }` map, empty until the operator
  // adds a row. Its rows are constrained dropdowns, so nothing invalid can be authored and there is
  // nothing to force open — the disclosure is the only state.
  const [workerDefaults, setWorkerDefaults] = useState<{ [type: string]: string }>({});
  const [showInput, setShowInput] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showWorkerDefaults, setShowWorkerDefaults] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });

  // Both fields always parse from their own text, not gated on their disclosure being open: a value
  // the operator typed is a value they meant to send, and gating on visibility would silently drop
  // it. One reading per field: parse, then "does this ask for anything at all".
  const inputReading = readOverride({ text: input });
  const configReading = readOverride({ text: config });
  const inputResult = inputReading.result;
  const configResult = configReading.result;
  // An override needs at least one top-level key: a blank field or a literal `{}` is "no override",
  // so the server falls back to the workflow file's own `input` seed (else `{}`).
  const inputValue = inputResult.ok ? inputResult.value : undefined;
  const inputOverride = inputReading.isEmpty ? undefined : inputValue;
  // An invalid value cannot hide behind a collapsed disclosure — that would disable launch with the
  // reason off-screen — so a bad value forces its own field open.
  const inputOpen = showInput || !inputResult.ok;
  const configOpen = showConfig || !configResult.ok;
  // A launch worker default can add a worker the file does not use, so its credential joins in.
  const placeholder =
    credentialPlaceholder([...workers, ...Object.values(workerDefaults)]) ?? configPlaceholder;
  const hasWorkerChoices = workerDefaultCandidates(plugins).length > 0;
  const workerDefaultCount = Object.keys(workerDefaults).length;
  const canLaunch =
    gate === null &&
    workflowPath !== null &&
    inputReading.canSubmit &&
    configReading.canSubmit &&
    submit.phase !== "sending";

  const launch = (): void => {
    if (
      gate !== null ||
      workflowPath === null ||
      !inputReading.canSubmit ||
      !configReading.canSubmit
    )
      return;
    setSubmit({ phase: "sending" });
    client
      .startRun({
        workflowPath,
        // An empty override is omitted, never sent as `{}` — the server then seeds the run from the
        // workflow file's own `input`.
        input: inputOverride,
        config: configResult.ok ? configResult.value : undefined,
        // An unset table is omitted, never sent as `{}`, matching the file channel's
        // `worker_defaults`.
        workerDefaults: workerDefaultCount > 0 ? workerDefaults : undefined,
      })
      .then((res) => {
        setSubmit({ phase: "idle" });
        onLaunched(res.root_run_id);
      })
      .catch((error: unknown) =>
        setSubmit({ phase: "error", message: renderMessage(errorMessage(error)) }),
      );
  };

  return (
    <div className="launch-form" data-testid={containerTestId}>
      {/* The disclosure titles the field, so the textarea is named by it (`labelledBy`) rather than
          printing the same words a second time as a field label. */}
      <button
        type="button"
        id={`${idBase}-input-toggle`}
        className="launch-disclosure"
        data-testid={`${testIdPrefix}-input-toggle`}
        aria-expanded={inputOpen}
        onClick={() => setShowInput((shown) => !shown)}
      >
        {inputOpen ? "▾" : "▸"} {t("overrides.overrideInput")}
        {inputOverride !== undefined && (
          <span className="launch-disclosure-dot"> · {t("overrides.set")}</span>
        )}
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
        {configOpen ? "▾" : "▸"} {t("overrides.overrideConfig")}
        {config.trim() !== "" && (
          <span className="launch-disclosure-dot"> · {t("overrides.set")}</span>
        )}
      </button>
      {configOpen && (
        <JsonField
          id={`${idBase}-config`}
          testId={`${testIdPrefix}-config`}
          label={t("overrides.configLabel")}
          value={config}
          onChange={setConfig}
          result={configResult}
          rows={3}
          placeholder={placeholder}
        />
      )}

      {/* The launch worker-default (ADR 0044) sits above every file's own `worker_defaults` and
          below a step's own `worker` pin. The disclosure names the section, so the editor prints no
          title. */}
      {hasWorkerChoices && (
        <>
          <button
            type="button"
            className="launch-disclosure"
            data-testid={`${testIdPrefix}-worker-defaults-toggle`}
            aria-expanded={showWorkerDefaults}
            onClick={() => setShowWorkerDefaults((shown) => !shown)}
          >
            {showWorkerDefaults ? "▾" : "▸"} {t("launchForm.workerDefaults")}
            {workerDefaultCount > 0 && (
              <span className="launch-disclosure-dot"> · {t("overrides.set")}</span>
            )}
          </button>
          {showWorkerDefaults && (
            <WorkerDefaultsEditor
              plugins={plugins}
              value={workerDefaults}
              onChange={setWorkerDefaults}
              hint={t("launchForm.workerDefaultsHint")}
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
          {submit.phase === "sending" ? t("launchForm.sending") : submitLabel}
          {warningCount > 0 && (
            <span className="run-warning-badge" data-testid={`${testIdPrefix}-warning-badge`}>
              ⚠ {warningCount}
            </span>
          )}
        </button>
      </div>

      {warningCount > 0 && gate === null && (
        <p className="run-warning" data-testid={`${testIdPrefix}-warning`} role="note">
          {t("launchForm.warning", { count: warningCount })}
        </p>
      )}

      {gate !== null && (
        <p className="pane-note run-gate" data-testid={`${testIdPrefix}-gate`}>
          {renderMessage(gate)}
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
