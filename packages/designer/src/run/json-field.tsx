import type { parseJsonField } from "@path/client-core";

/**
 * One raw-JSON textarea with its live client-side lint line, shared by the launch form's `input`/`config`
 * fields and the resume form's `config` override. The parse/shape gate itself is `parseJsonField`
 * (client-core, § Shared seam) — this only renders one field's text, hint, and invalid state. The
 * Designer's own presentation (ADR 0025).
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
}): JSX.Element {
  const hint = result.ok ? (result.empty ? "empty — field omitted" : "valid JSON") : result.message;
  return (
    <div className="run-field">
      <label className="run-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        data-testid={testId}
        className="run-textarea"
        value={value}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={result.ok ? undefined : true}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className={`run-lint${result.ok ? "" : " run-lint--bad"}`}>{hint}</p>
    </div>
  );
}
