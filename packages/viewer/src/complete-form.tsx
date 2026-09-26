import {
  buildCompleteFields,
  type CompleteField,
  type CompleteFieldValue,
  coerceCompleteOutput,
  coerceRawCompleteOutput,
  type JsonValue,
  launchSecretResupply,
  mapCompleteErrors,
  type PathApiClient,
  PathApiError,
  resupplyGate,
  validateCompleteDraft,
} from "@path/client-core";
import { useMemo, useState } from "react";
import { errorMessage } from "./load-state.js";

export interface CompleteFormProps {
  client: PathApiClient;
  /** The awaiting leaf's run id — the `:step_run_id` the Complete route names. */
  stepRunId: string;
  /** The node's `outputSchema`, or `null` for a node that accepts any JSON (an empty output). */
  outputSchema: JsonValue | null;
  /**
   * The launch config dot-paths the tree recorded as `$secret`-masked (ADR 0046). Non-empty, the form
   * draws an optional config field prefilled with a skeleton of those paths, because a continuation
   * recovers the frozen config and its `[secret:<key>]` tokens cannot run — the operator supplies the
   * values again. Empty or absent, no config field renders: there is nothing to re-enter.
   */
  launchSecretKeys?: readonly string[];
  /** The submit button's label. Defaults to the panel's "Complete this activity". */
  submitLabel?: string;
  /** Called on a `202` — the leaf is `succeeded` and the root's SSE stream carries the continuation. */
  onCompleted: () => void;
}

/**
 * The Complete form built from a `person-activity` node's `outputSchema` (ADR 0040). The field list,
 * value coercion, client pre-check and server-`400`→field mapping are the framework-free model in
 * `@path/client-core`, shared with the Designer; this component is only the controls, state and submit.
 *
 * The server is the authority: a `400` still lands and its **own** field errors (ajv's messages,
 * verbatim) replace the client's, while the leaf stays `awaiting` for a corrected resubmit. A node with
 * **no** schema accepts any JSON, so the form draws a single free-text control instead of no fields — it
 * takes JSON as its value, plain prose as a JSON string, and blank as an empty output, so it never rejects.
 */
export function CompleteForm({
  client,
  stepRunId,
  outputSchema,
  launchSecretKeys,
  submitLabel = "Complete this activity",
  onCompleted,
}: CompleteFormProps) {
  const fields = useMemo(() => buildCompleteFields(outputSchema), [outputSchema]);
  // A schema with no drawable fields (none authored) falls back to the free-text control.
  const raw = fields.length === 0;
  const secrets = launchSecretKeys ?? [];
  const resupply = launchSecretResupply(secrets);
  const showSecrets = resupply.required;
  const [values, setValues] = useState<Partial<Record<string, CompleteFieldValue>>>({});
  const [rawText, setRawText] = useState("");
  // Prefilled from the tree's recorded secret paths, so the operator fills values rather than retyping
  // the shape. Lazy init: the skeleton is built once per mount.
  const [configText, setConfigText] = useState(() => resupply.skeleton);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "sending">("idle");

  const setValue = (key: string, value: CompleteFieldValue): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  // The shared secret-restore gate (ADR 0046, `@path/client-core`) — the same verdict the Resume card
  // reads. A recorded launch secret is a credential the frozen config holds only as a mask token, so the
  // form refuses one the operator left blank: the engine would otherwise fall through to the environment.
  // Derived from the text, so the button is disabled from the moment the skeleton is on screen.
  const gate = resupplyGate(secrets, configText, "completing");
  const blankSecrets = gate.blankPaths;

  const submit = (): void => {
    let output: JsonValue;
    if (raw) {
      // The free-text control never rejects: JSON becomes its value, anything else a JSON string.
      output = coerceRawCompleteOutput(rawText);
    } else {
      output = coerceCompleteOutput(fields, values);
      // The same validator the route runs, over the node's own schema: a `pattern`, a `minimum` or a
      // nested shape is caught here now rather than coming back as a `400`.
      const clientErrors = validateCompleteDraft(outputSchema, output);
      if (Object.keys(clientErrors.fieldErrors).length > 0 || clientErrors.formErrors.length > 0) {
        setFieldErrors(clientErrors.fieldErrors);
        setFormErrors(clientErrors.formErrors);
        return;
      }
      setFieldErrors({});
    }
    setFormErrors([]);
    // The continuation's config is a separate gate from the output: an unparseable value, or a blank at
    // a path the launch recorded as a secret, blocks the submit with no request spent. Blank parses to
    // `undefined`, so a run with no secrets sends the same `{ output }` body as before.
    const submitGate = resupplyGate(secrets, configText, "completing");
    if (!submitGate.configResult.ok) {
      setFormErrors([submitGate.configResult.message]);
      return;
    }
    if (submitGate.blockMessage !== null) {
      setFormErrors([submitGate.blockMessage]);
      return;
    }
    setPhase("sending");
    client.completeStep(stepRunId, output, submitGate.configResult.value).then(
      () => {
        setPhase("idle");
        onCompleted();
      },
      (thrown: unknown) => {
        setPhase("idle");
        // A 400 carries the server's ajv issues in `details` — map them onto the fields (leaf stays
        // awaiting for a retry). Any other failure (404/409, transport) has no per-field shape, so it
        // reads at the form level.
        if (thrown instanceof PathApiError && thrown.status === 400) {
          const mapped = mapCompleteErrors(thrown.details);
          setFieldErrors(mapped.fieldErrors);
          setFormErrors(mapped.formErrors.length > 0 ? mapped.formErrors : [thrown.message]);
        } else {
          setFormErrors([errorMessage(thrown)]);
        }
      },
    );
  };

  return (
    <form
      className="complete-form"
      data-testid="complete-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {raw ? (
        <RawOutputControl value={rawText} onChange={setRawText} />
      ) : (
        fields.map((field) => (
          <CompleteControl
            key={field.key}
            field={field}
            value={values[field.key]}
            error={fieldErrors[field.key]}
            onChange={(value) => setValue(field.key, value)}
          />
        ))
      )}

      {showSecrets && <LaunchSecretsControl value={configText} onChange={setConfigText} />}

      {gate.blockMessage !== null && (
        <p
          className="pane-note pane-error complete-form-error"
          role="alert"
          data-testid="complete-secret-error"
        >
          {gate.blockMessage}
        </p>
      )}

      {formErrors.map((message, index) => (
        <p
          key={message}
          className="pane-note pane-error complete-form-error"
          role="alert"
          data-testid="complete-form-error"
        >
          {message}
        </p>
      ))}

      <div className="launch-actions">
        <button
          type="submit"
          className="launch-submit"
          data-testid="complete-submit"
          disabled={phase === "sending" || blankSecrets.length > 0}
        >
          {phase === "sending" ? "Submitting…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

interface RawOutputControlProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * The one control a schema-less `person-activity` node draws: a free-text textarea for the step's
 * `${output}`. It never rejects (ADR 0040: any JSON is accepted) — plain text submits as a JSON string,
 * JSON as its value, blank as an empty output.
 */
function RawOutputControl({ value, onChange }: RawOutputControlProps) {
  const id = "complete-fld-__raw";

  return (
    <div className="complete-field" data-testid="complete-field-__raw">
      <label className="field-label complete-label" htmlFor={id}>
        Output
      </label>
      <p className="complete-help">
        Enter any text, or JSON for a structured value. Leave blank to submit an empty output.
      </p>
      <textarea
        id={id}
        className="launch-textarea complete-input"
        rows={4}
        value={value}
        data-testid="complete-raw-output"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

interface LaunchSecretsControlProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * The Complete form's optional config override, drawn only when the launch recorded `$secret` config
 * (ADR 0046). Prefilled with the masked paths' skeleton; the frozen values are stored masked and the
 * engine refuses to continue with a token.
 */
function LaunchSecretsControl({ value, onChange }: LaunchSecretsControlProps) {
  const id = "complete-fld-__config";

  return (
    <div className="complete-field" data-testid="complete-field-__config">
      <label className="field-label complete-label" htmlFor={id}>
        Launch secrets (config override) · JSON
      </label>
      <p className="complete-help" data-testid="complete-config-note">
        These launch secrets are stored masked and must be supplied again to continue the run.
      </p>
      <textarea
        id={id}
        className="launch-textarea complete-input"
        rows={4}
        value={value}
        spellCheck={false}
        data-testid="complete-config"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

interface CompleteControlProps {
  field: CompleteField;
  value: CompleteFieldValue | undefined;
  error: string | undefined;
  onChange: (value: CompleteFieldValue) => void;
}

/** One schema-driven control: a checkbox, a select, or a text/number input, with its help and error. */
function CompleteControl({ field, value, error, onChange }: CompleteControlProps) {
  const id = `complete-fld-${field.key}`;
  const errId = `${id}-err`;
  const invalid = error !== undefined;
  const describedBy = invalid ? errId : undefined;

  return (
    <div
      className={`complete-field${invalid ? " complete-field--invalid" : ""}`}
      data-testid={`complete-field-${field.key}`}
    >
      {field.kind === "boolean" ? (
        <label className="complete-check" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="complete-label-text">
            {field.title}
            {field.required && (
              <span className="complete-req" aria-hidden="true">
                {" "}
                *
              </span>
            )}
          </span>
        </label>
      ) : (
        <>
          <label className="field-label complete-label" htmlFor={id}>
            {field.title}
            {field.required && (
              <span className="complete-req" aria-hidden="true">
                {" "}
                *
              </span>
            )}
          </label>
          {field.description !== null && <p className="complete-help">{field.description}</p>}
          {field.kind === "enum" ? (
            <select
              id={id}
              className="complete-select"
              value={typeof value === "string" ? value : ""}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.value)}
            >
              <option value="">— select —</option>
              {field.enum?.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : field.multiline ? (
            <textarea
              id={id}
              className="launch-textarea complete-input"
              rows={3}
              value={typeof value === "string" ? value : ""}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <input
              id={id}
              type={field.kind === "number" || field.kind === "integer" ? "number" : "text"}
              className="complete-input"
              value={typeof value === "string" ? value : ""}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </>
      )}
      {invalid && (
        <p className="complete-field-error" id={errId}>
          {error}
        </p>
      )}
    </div>
  );
}
