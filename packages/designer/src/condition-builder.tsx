import { useState } from "react";
import type { Condition, JsonScalar } from "@path/schema";
import {
  CONDITION_TYPES,
  changeConditionType,
  defaultScalar,
  isLeafConditionType,
  scalarKind,
  validateCondition,
  type ScalarKind,
} from "./condition-edit.js";

import type { ReactNode } from "react";

/**
 * The typed `Condition` builder (#370, designer-spec § Canvas interaction model, ADR 0022). It edits the
 * structured AST — an operator picked from a menu, its operands in typed controls — never free text, so
 * an ill-typed or unparseable condition is **unrepresentable**, the structural analogue of the unsnappable
 * socket. One `ConditionField` governs each of the three condition sites: a branch arm's `when`, a
 * `while-do`'s `condition`, and a `checkpoint`'s assertion, each inside a labelled fieldset (the label on
 * the border).
 *
 * A sub-condition is committed only when the **whole** condition validates (`validateCondition`): the
 * builder edits a draft and calls `onChange` only for a valid draft, so a half-typed dot-path never
 * reaches the file and the node stays strict-valid, exactly as the raw-JSON floor keeps a leaf strict
 * (#369). Give each field a stable React `key` so selecting another node reseeds the draft.
 */
export function ConditionField({
  label,
  condition,
  suggestions,
  onChange,
}: {
  label: string;
  condition: Condition;
  suggestions: string[];
  onChange: (next: Condition) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Condition>(condition);
  const update = (next: Condition): void => {
    setDraft(next);
    if (validateCondition(next) === null) onChange(next);
  };
  const error = validateCondition(draft);
  return (
    <fieldset className="cond-fieldset">
      <legend className="cond-legend">{label}</legend>
      <ConditionNode value={draft} suggestions={suggestions} onChange={update} />
      {error ? (
        <p className="pane-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** One condition row: the operator menu, then the operands the chosen operator needs (recursive for combinators). */
function ConditionNode({
  value,
  suggestions,
  onChange,
}: {
  value: Condition;
  suggestions: string[];
  onChange: (next: Condition) => void;
}): JSX.Element {
  const operator = (
    <select
      className="pane-input cond-op"
      aria-label="Operator"
      value={value.type}
      onChange={(e) => onChange(changeConditionType(value, e.target.value as Condition["type"]))}
    >
      {CONDITION_TYPES.map((type) => (
        <option key={type} value={type}>
          {type}
        </option>
      ))}
    </select>
  );
  // A leaf predicate reads infix — `path <operator> operand` — on one control row, each control under its
  // label (§ ADR 0022, condition row). A combinator (`all`/`any`/`not`) keeps the operator as a prefix
  // above its indented children, so the tree structure still reads top-down.
  if (isLeafConditionType(value.type)) {
    return (
      <div className="cond-node cond-leaf">
        <ConditionOperands value={value} suggestions={suggestions} onChange={onChange} operator={operator} />
      </div>
    );
  }
  return (
    <div className="cond-node">
      {operator}
      <ConditionOperands value={value} suggestions={suggestions} onChange={onChange} operator={null} />
    </div>
  );
}

/** The operand controls for a condition, dispatched by operator. Every control writes a valid operand. */
function ConditionOperands({
  value,
  suggestions,
  onChange,
  operator,
}: {
  value: Condition;
  suggestions: string[];
  onChange: (next: Condition) => void;
  /** The operator select, rendered infix right after the path for a leaf predicate; `null` for a combinator. */
  operator: ReactNode;
}): JSX.Element {
  switch (value.type) {
    case "exists":
    case "valid-json":
      return (
        <>
          <PathField path={value.path} suggestions={suggestions} onChange={(path) => onChange({ ...value, path })} />
          {operator}
        </>
      );
    case "equals":
      return (
        <>
          <PathField path={value.path} suggestions={suggestions} onChange={(path) => onChange({ ...value, path })} />
          {operator}
          <ScalarField value={value.value} onChange={(scalar) => onChange({ ...value, value: scalar })} />
        </>
      );
    case "matches":
      return (
        <>
          <PathField path={value.path} suggestions={suggestions} onChange={(path) => onChange({ ...value, path })} />
          {operator}
          <label className="cond-operand">
            <span className="pane-label">pattern</span>
            <input
              className="pane-input"
              type="text"
              value={value.pattern}
              onChange={(e) => onChange({ ...value, pattern: e.target.value })}
            />
          </label>
        </>
      );
    case "range":
      return (
        <>
          <PathField path={value.path} suggestions={suggestions} onChange={(path) => onChange({ ...value, path })} />
          {operator}
          <div className="cond-range">
            <OptionalNumber label="min" value={value.min} onChange={(n) => onChange(withBound(value, "min", n))} />
            <OptionalNumber label="max" value={value.max} onChange={(n) => onChange(withBound(value, "max", n))} />
          </div>
        </>
      );
    case "one-of":
      return (
        <>
          <PathField path={value.path} suggestions={suggestions} onChange={(path) => onChange({ ...value, path })} />
          {operator}
          <ScalarListField values={value.values} onChange={(values) => onChange({ ...value, values })} />
        </>
      );
    case "not":
      return (
        <div className="cond-children">
          <ConditionNode value={value.of} suggestions={suggestions} onChange={(child) => onChange({ ...value, of: child })} />
        </div>
      );
    case "all":
    case "any":
      return <CombinatorChildren value={value} suggestions={suggestions} onChange={onChange} />;
  }
}

/** The `all` / `any` child list, each an editable sub-condition, with add and remove (keeps at least one). */
function CombinatorChildren({
  value,
  suggestions,
  onChange,
}: {
  value: { type: "all" | "any"; of: Condition[] };
  suggestions: string[];
  onChange: (next: Condition) => void;
}): JSX.Element {
  const setChild = (index: number, child: Condition): void =>
    onChange({ ...value, of: value.of.map((c, i) => (i === index ? child : c)) });
  const removeChild = (index: number): void => onChange({ ...value, of: value.of.filter((_, i) => i !== index) });
  const addChild = (): void => onChange({ ...value, of: [...value.of, { type: "exists", path: "context.value" }] });
  return (
    <div className="cond-children">
      {value.of.map((child, index) => (
        <div className="cond-child" key={index}>
          <ConditionNode value={child} suggestions={suggestions} onChange={(c) => setChild(index, c)} />
          {value.of.length > 1 ? (
            <button type="button" className="pane-btn cond-remove" aria-label="Remove condition" onClick={() => removeChild(index)}>
              ×
            </button>
          ) : null}
        </div>
      ))}
      <button type="button" className="pane-btn cond-add" onClick={addChild}>
        + add condition
      </button>
    </div>
  );
}

/** A leaf predicate's dot-path, with autocomplete against the file's referenceable `context.`/`output.` paths. */
function PathField({ path, suggestions, onChange }: { path: string; suggestions: string[]; onChange: (path: string) => void }): JSX.Element {
  const listId = `cond-paths-${useListId()}`;
  return (
    <label className="cond-operand">
      <span className="pane-label">path</span>
      <input className="pane-input" type="text" value={path} list={listId} onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </label>
  );
}

/** A typed JSON-scalar operand: a kind menu (`string`/`number`/`boolean`/`null`) and the value control. */
function ScalarField({ value, onChange }: { value: JsonScalar; onChange: (value: JsonScalar) => void }): JSX.Element {
  const kind = scalarKind(value);
  return (
    <div className="cond-operand cond-scalar">
      <span className="pane-label">value</span>
      <div className="cond-scalar-controls">
        <select
          className="pane-input cond-scalar-kind"
          aria-label="Value type"
          value={kind}
          onChange={(e) => onChange(defaultScalar(e.target.value as ScalarKind))}
        >
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="null">null</option>
        </select>
        <ScalarValue kind={kind} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

/** The value control matched to a scalar kind: text, number, a boolean menu, or nothing for `null`. */
function ScalarValue({ kind, value, onChange }: { kind: ScalarKind; value: JsonScalar; onChange: (value: JsonScalar) => void }): JSX.Element | null {
  if (kind === "null") return null;
  if (kind === "boolean") {
    return (
      <select
        className="pane-input"
        aria-label="Boolean value"
        value={value === true ? "true" : "false"}
        onChange={(e) => onChange(e.target.value === "true")}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (kind === "number") {
    return (
      <input
        className="pane-input"
        type="number"
        aria-label="Number value"
        value={typeof value === "number" ? value : 0}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      />
    );
  }
  return (
    <input
      className="pane-input"
      type="text"
      aria-label="String value"
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A `one-of` value set: a typed scalar per row, with add and remove (keeps at least one). */
function ScalarListField({ values, onChange }: { values: JsonScalar[]; onChange: (values: JsonScalar[]) => void }): JSX.Element {
  const setAt = (index: number, scalar: JsonScalar): void => onChange(values.map((v, i) => (i === index ? scalar : v)));
  const removeAt = (index: number): void => onChange(values.filter((_, i) => i !== index));
  return (
    <div className="cond-list">
      {values.map((v, index) => (
        <div className="cond-list-row" key={index}>
          <ScalarField value={v} onChange={(scalar) => setAt(index, scalar)} />
          {values.length > 1 ? (
            <button type="button" className="pane-btn cond-remove" aria-label="Remove value" onClick={() => removeAt(index)}>
              ×
            </button>
          ) : null}
        </div>
      ))}
      <button type="button" className="pane-btn cond-add" onClick={() => onChange([...values, ""])}>
        + add value
      </button>
    </div>
  );
}

/** An optional numeric bound (`min` / `max`), blank when unset. */
function OptionalNumber({ label, value, onChange }: { label: string; value: number | undefined; onChange: (n: number | null) => void }): JSX.Element {
  return (
    <label className="cond-operand">
      <span className="pane-label">{label}</span>
      <input
        className="pane-input"
        type="number"
        value={value === undefined ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </label>
  );
}

/** Set or clear one bound of a `range`, rebuilding the operand so a cleared bound drops its key. */
function withBound(value: Extract<Condition, { type: "range" }>, key: "min" | "max", n: number | null): Condition {
  const next: Extract<Condition, { type: "range" }> = { type: "range", path: value.path };
  const min = key === "min" ? (n ?? undefined) : value.min;
  const max = key === "max" ? (n ?? undefined) : value.max;
  if (min !== undefined) next.min = min;
  if (max !== undefined) next.max = max;
  return next;
}

/** A process-unique id suffix, so two path fields on screen never share a `<datalist>` id. */
let listCounter = 0;
function useListId(): number {
  const [id] = useState(() => (listCounter += 1));
  return id;
}
