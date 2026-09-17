import {
  buildCompleteFields,
  coerceCompleteOutput,
  mapCompleteErrors,
  parseRawCompleteOutput,
  PathApiError,
  validateCompleteOutput,
  type CompleteField,
  type CompleteFieldValue,
  type JsonValue,
  type PathApiClient,
} from "@path/client-core";
import { useMemo, useState } from "react";
import { errorMessage } from "./load-state.js";

export interface CompleteFormProps {
  client: PathApiClient;
  /** The awaiting leaf's run id — the `:step_run_id` the Complete route names. */
  stepRunId: string;
  /** The node's `outputSchema`, or `null` for a node that accepts any JSON (an empty output). */
  outputSchema: JsonValue | null;
  /** The submit button's label. Defaults to the panel's "Complete this activity". */
  submitLabel?: string;
  /** Called on a `202` — the leaf is `succeeded` and the root's SSE stream carries the continuation. */
  onCompleted: () => void;
}

/**
 * The Complete form built from a `person-activity` node's `outputSchema` (ADR 0040). The field list,
 * value coercion, client pre-check, and the server-`400`→field mapping are the framework-free model in
 * `@path/client-core` (`complete-form.ts`), shared with the Designer; this component is only the
 * controls, their state, and the submit.
 *
 * The server is the authority: a client pre-check that passes is never a promise, so a `400` still
 * lands and its **own** field errors (ajv's messages, verbatim) replace the client's. On a `400` the
 * leaf stays `awaiting` — the same form is ready for a corrected resubmit. A node with **no** schema
 * (`outputSchema` omitted) accepts any JSON (ADR 0040), so the form draws a single raw-JSON control
 * instead of no fields at all — otherwise the person had nowhere to enter the `${output}` the step
 * publishes. Blank raw text still submits an empty output, the historical bare-submit.
 */
export function CompleteForm({ client, stepRunId, outputSchema, submitLabel = "Complete this activity", onCompleted }: CompleteFormProps) {
  const fields = useMemo(() => buildCompleteFields(outputSchema), [outputSchema]);
  // A schema with no drawable fields (none authored) falls back to the raw-JSON control.
  const raw = fields.length === 0;
  const [values, setValues] = useState<Partial<Record<string, CompleteFieldValue>>>({});
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "sending">("idle");

  const setValue = (key: string, value: CompleteFieldValue): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const submit = (): void => {
    let output: JsonValue;
    if (raw) {
      const parsed = parseRawCompleteOutput(rawText);
      if (!parsed.ok) {
        setRawError(parsed.error);
        setFormErrors([]);
        return;
      }
      output = parsed.value;
      setRawError(null);
    } else {
      output = coerceCompleteOutput(fields, values);
      const clientErrors = validateCompleteOutput(fields, output);
      if (Object.keys(clientErrors).length > 0) {
        setFieldErrors(clientErrors);
        setFormErrors([]);
        return;
      }
      setFieldErrors({});
    }
    setFormErrors([]);
    setPhase("sending");
    client.completeStep(stepRunId, output).then(
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
        <RawOutputControl value={rawText} error={rawError} onChange={setRawText} />
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

      {formErrors.map((message, index) => (
        <p key={index} className="pane-note pane-error complete-form-error" role="alert" data-testid="complete-form-error">
          {message}
        </p>
      ))}

      <div className="launch-actions">
        <button type="submit" className="launch-submit" data-testid="complete-submit" disabled={phase === "sending"}>
          {phase === "sending" ? "Submitting…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

interface RawOutputControlProps {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}

/**
 * The one control a schema-less `person-activity` node draws: a raw-JSON textarea for the step's
 * `${output}`. Any JSON value is accepted (ADR 0040); blank submits an empty output.
 */
function RawOutputControl({ value, error, onChange }: RawOutputControlProps) {
  const id = "complete-fld-__raw";
  const errId = `${id}-err`;
  const invalid = error !== null;

  return (
    <div className={`complete-field${invalid ? " complete-field--invalid" : ""}`} data-testid="complete-field-__raw">
      <label className="field-label complete-label" htmlFor={id}>
        Output
      </label>
      <p className="complete-help">Enter the step&rsquo;s output as JSON. Leave blank to submit an empty output.</p>
      <textarea
        id={id}
        className="launch-textarea complete-input"
        rows={4}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errId : undefined}
        data-testid="complete-raw-output"
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid && (
        <p className="complete-field-error" id={errId}>
          {error}
        </p>
      )}
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
    <div className={`complete-field${invalid ? " complete-field--invalid" : ""}`} data-testid={`complete-field-${field.key}`}>
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
            {field.required && <span className="complete-req" aria-hidden="true"> *</span>}
          </span>
        </label>
      ) : (
        <>
          <label className="field-label complete-label" htmlFor={id}>
            {field.title}
            {field.required && <span className="complete-req" aria-hidden="true"> *</span>}
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
