import type { parseJsonField } from "./launch-json.js";

/**
 * One raw-JSON textarea with its live client-side lint line, shared by the launch form's `input`/
 * `config` fields (#233) and the resume form's `config` override (§4.3). The parse/shape gate itself
 * is `parseJsonField` (launch-json.ts) — this only renders one field's text, hint, and invalid state.
 */
export function JsonField({
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
