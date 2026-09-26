import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";

/**
 * The properties pane's generic, schema-blind field vocabulary: the label/input/select/textarea atoms,
 * the id row, and the Tab-fills-placeholder handler. A field that carries schema validation
 * (max-iterations, the raw-JSON floor, the keyed-row editors) stays in `properties-pane.tsx`.
 */

/**
 * Tab in a pane field showing a placeholder fills the placeholder in instead of moving focus; a field
 * that already holds text shows none, so Tab keeps its normal focus-move there. Delegated from the pane
 * root so every input is covered. The value goes through the element's native setter plus an `input`
 * event, so React's controlled `onChange` runs (a plain `.value =` would not notify React).
 */
export function fillPlaceholderOnTab(e: ReactKeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (el.value !== "" || el.placeholder === "") return;
  e.preventDefault();
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setValue?.call(el, el.placeholder);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The `id` row: the read-only id and a confirmation-gated re-key, guarded because minting a new id
 * breaks resume plan-reuse (ADR 0015).
 */
export function IdRow({
  id,
  onReKey,
  what,
}: {
  id: string;
  onReKey: () => void;
  what: string;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="pane-field pane-field-row">
      <span className="pane-label">id</span>
      <div className="pane-id-row">
        <code className="pane-id">{id}</code>
        {confirming ? (
          <span className="pane-rekey-confirm">
            <button
              type="button"
              className="pane-btn pane-btn-danger"
              onClick={() => {
                onReKey();
                setConfirming(false);
              }}
            >
              Confirm re-key
            </button>
            <button type="button" className="pane-btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="pane-btn" onClick={() => setConfirming(true)}>
            Re-key
          </button>
        )}
      </div>
      {confirming ? (
        <p className="pane-warn" role="alert">
          Re-keying {what} mints a new id and breaks resume plan-reuse for existing runs.
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="pane-field pane-field-row">
      <span className="pane-label">{label}</span>
      <input
        className="pane-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="pane-field pane-field-row pane-field-multiline">
      <span className="pane-label">{label}</span>
      <textarea
        className="pane-input"
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}): JSX.Element {
  return (
    <label className="pane-field pane-field-row">
      <span className="pane-label">{label}</span>
      <input
        className="pane-input"
        type="number"
        value={value === null ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </label>
  );
}

export function CheckboxField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="pane-field pane-field-inline">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="pane-label">{label}</span>
    </label>
  );
}

export function StringListField({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
}): JSX.Element {
  // The textarea keeps its own raw text so a just-typed Enter (a trailing or blank line) survives the
  // keystroke. The parent only sees non-empty lines, and the draft resyncs when the parent's canonical
  // value diverges — not on the round-trip of our own emit, which would strip those lines.
  const joined = values.join("\n");
  const [text, setText] = useState(joined);
  const [prevJoined, setPrevJoined] = useState(joined);
  if (joined !== prevJoined) {
    setPrevJoined(joined);
    setText(joined);
  }
  return (
    <label className="pane-field pane-field-row pane-field-multiline">
      <span className="pane-label">
        {label}
        <span className="pane-label-note">(one per line)</span>
      </span>
      <textarea
        className="pane-input"
        rows={3}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.split("\n").filter((line) => line.length > 0));
        }}
      />
    </label>
  );
}

export function SelectField({
  label,
  value,
  options,
  optionLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  optionLabel?: (option: string) => string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="pane-field pane-field-row">
      <span className="pane-label">{label}</span>
      <select className="pane-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel ? optionLabel(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ReadOnlyRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="pane-field pane-field-row">
      <span className="pane-label">{label}</span>
      <code className="pane-id">{value}</code>
    </div>
  );
}
