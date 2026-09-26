import type { parseJsonField } from "@path/client-core";

/**
 * One raw-JSON textarea with its live client-side lint line, shared by the launch form's `input`/
 * `config` fields and the resume form's `config` override. The parse/shape gate is `parseJsonField`;
 * this only renders the text, hint and invalid state.
 *
 * Pass `labelledBy` when an existing title already names the field, so words are not printed twice.
 */
export function JsonField({
  id,
  testId,
  label,
  labelledBy,
  value,
  onChange,
  result,
  rows,
  placeholder,
}: {
  id: string;
  testId: string;
  /** The field's own visible label. Omit it when `labelledBy` names the field instead. */
  label?: string;
  /** Id of the visible element that names this field — its disclosure title instead of a label. */
  labelledBy?: string;
  value: string;
  onChange: (next: string) => void;
  result: ReturnType<typeof parseJsonField>;
  rows: number;
  placeholder?: string;
}) {
  const hint = result.ok ? (result.empty ? "empty — field omitted" : "valid JSON") : result.message;
  return (
    <div className="launch-field">
      {label !== undefined && (
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
      )}
      <textarea
        id={id}
        data-testid={testId}
        className="launch-textarea"
        value={value}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        aria-labelledby={labelledBy}
        aria-invalid={result.ok ? undefined : true}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className={`launch-lint${result.ok ? "" : " launch-lint--bad"}`}>{hint}</p>
    </div>
  );
}
