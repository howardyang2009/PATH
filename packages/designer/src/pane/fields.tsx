import { checkInterpolationSyntax, type InterpolationRoot } from "@path/schema";
import { type ReactNode, useId, useState } from "react";
import type { EditKey } from "../edit-key.js";
import {
  type DraftResult,
  type KeyedRow,
  useValidatedDraft,
  validateMaxIterations,
} from "../validated-draft.js";

/**
 * One keyed-row line — `key = value ×` — behind both `publish` and the file's `output`. The value is
 * live-checked against the field's own `roots`; the row is transparent to the grid (`display: contents`)
 * so its cells share the section grid. Labels and placeholders come from the owner.
 */
export function KeyedRowField({
  row,
  roots,
  keyLabel,
  valueLabel,
  removeLabel,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
  onRemove,
}: {
  row: KeyedRow;
  roots: readonly InterpolationRoot[];
  keyLabel: string;
  valueLabel: string;
  removeLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: (row: KeyedRow) => string;
  onChange: (row: KeyedRow) => void;
  onRemove: () => void;
}): JSX.Element {
  const check = checkInterpolationSyntax(row.value, roots);
  return (
    <div className="pane-publish-row">
      <input
        className="pane-input"
        type="text"
        aria-label={keyLabel}
        placeholder={keyPlaceholder}
        value={row.key}
        onChange={(e) => onChange({ ...row, key: e.target.value })}
      />
      <span className="pane-publish-eq" aria-hidden="true">
        =
      </span>
      <div className="pane-publish-value">
        <input
          className="pane-input"
          type="text"
          aria-label={valueLabel}
          placeholder={valuePlaceholder(row)}
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          aria-invalid={!check.ok}
        />
        <button type="button" className="pane-btn" aria-label={removeLabel} onClick={onRemove}>
          ×
        </button>
      </div>
      {!check.ok ? (
        <p className="pane-error" role="alert">
          {check.error}
        </p>
      ) : null}
    </div>
  );
}

// ── The max-iterations field (schema-validated, so it stays with the pane) ─────────────────────────

/**
 * `while-do`'s **max iterations**: a positive whole number or a `${config.…}` / `${context.…}`
 * interpolation (`MaxIterationsSchema`), so it must be a text field held as a draft — digits commit as a
 * number, a valid interpolation as a string, anything else is flagged and not committed.
 */
export function MaxIterationsField({
  label = "max iterations",
  identity,
  value,
  onChange,
}: {
  label?: string;
  identity: EditKey;
  value: number | string;
  onChange: (v: number | string) => void;
}): JSX.Element {
  const id = useId();
  const { draft, error, onEdit } = useValidatedDraft(
    () => String(value),
    validateMaxIterations,
    identity,
    onChange,
  );

  return (
    <div className="pane-field pane-field-row">
      <label className="pane-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="pane-input"
        type="text"
        value={draft}
        placeholder="10 or ${config.max_revisions}"
        onChange={(e) => onEdit(e.target.value)}
        aria-invalid={error !== null}
      />
      <FieldError error={error} />
    </div>
  );
}

// ── Shared field pieces ───────────────────────────────────────────────────────────────────────────

/**
 * A live-validated JSON textarea: only a valid value commits, and an invalid draft shows its error
 * without touching the node.
 */
export function JsonDraftField<T>({
  id,
  label,
  rows,
  initial,
  validate,
  identity,
  commit,
}: {
  id: string;
  label: string;
  rows: number;
  initial: () => string;
  validate: (text: string) => DraftResult<T>;
  identity: EditKey;
  commit: (value: T) => void;
}): JSX.Element {
  const { draft, error, onEdit } = useValidatedDraft(initial, validate, identity, commit);
  return (
    <div className="pane-field">
      <label className="pane-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="pane-input pane-json"
        value={draft}
        onChange={(e) => onEdit(e.target.value)}
        aria-invalid={error !== null}
        rows={rows}
      />
      <FieldError error={error} />
    </div>
  );
}

/** A field's validation error, announced to assistive tech; nothing when the draft is valid. */
export function FieldError({ error }: { error: string | null }): JSX.Element | null {
  return error ? (
    <p className="pane-error" role="alert">
      {error}
    </p>
  ) : null;
}

/**
 * One collapsible region: its title is the toggle, and the body mounts only while open. The caller
 * picks the default — field sections expanded (`defaultOpen`), payload regions collapsed — so a closed
 * region is not in the DOM and cannot be tabbed into.
 */
export function PaneSection({
  title,
  className,
  defaultOpen = false,
  children,
}: {
  title: string;
  className?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className === undefined ? "pane-section" : `pane-section ${className}`}>
      <button
        type="button"
        className="pane-section-toggle"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span className="pane-section-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="pane-section-title">{title}</span>
      </button>
      {open ? <div className="pane-section-body">{children}</div> : null}
    </div>
  );
}
