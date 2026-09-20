import { useState } from "react";
import type { WireStepPlugin } from "@path/client-core";
import {
  FORMAT_VERSION,
  STEP_ROOTS,
  checkInterpolationSyntax,
  safeParseWorkflowFile,
  type InterpolationRoot,
  type JsonValue,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import { sameEditKey, type EditKey } from "./edit-key.js";
import { withoutKey } from "./edit-target.js";
import { dropNodeKey, mergeNodePayload, setNodeField } from "./node-edit.js";
import { parseInputDraft } from "./interp-suggest.js";
import { wireToRegistry } from "./open-workflow.js";

/**
 * The one **draft → validate → commit** protocol behind the properties pane's live-validated fields
 * (#369/#370, designer-spec § Editors, § Input/output wiring, § Context reads and writes). The rule the
 * pane must never break: an author sees a draft while it is invalid, but an invalid draft is **never
 * committed**, so the node (or file) on the canvas stays strict-valid — only the editor's fidelity
 * degrades. That rule used to be re-spelled in each field. Here it has one core and three shapes:
 *
 * - **`useDraft`** — the core: hold a draft of any type, run a pure `validate` on each edit, commit only
 *   the `ok` value, re-seed when the field's **identity** changes (`edit-key.ts`).
 * - **`useValidatedDraft`** — the single-text field (the raw-JSON floor, the input object, the
 *   max-iterations line) as that core over a string.
 * - **`ConditionField`** (`condition-builder.tsx`) — the structured `Condition` builder as the same core
 *   over an AST, so it no longer hand-rolls the hold-validate-commit dance and no longer depends on a
 *   React `key` its caller had to remember.
 * - **`useKeyedRows` / `validRowsToMap`** — the key→value row list (the publish map, the file output
 *   map): the pure guard says whether the rows *can* commit, and the hook commits through the core.
 *
 * The `validate*` functions are pure and unit-tested directly, off the pane's render path.
 */

/**
 * The outcome of validating one draft: a committable value, or a message to show and not commit. The
 * message is optional, because a field may hold a draft **silently** — a keyed row mid-edit commits
 * nothing and shows no error, where the raw-JSON floor names what is wrong.
 */
export type DraftResult<T> = { ok: true; value: T } | { ok: false; error?: string };

/**
 * The protocol's core, over a draft of `D` that validates into a committable `C`.
 *
 * `initial` seeds the draft (lazily, so a re-seed costs nothing until the identity actually changes);
 * `validate` is the pure per-field rule; `identity` is which field this draft belongs to — when it
 * changes the draft re-seeds, so selecting another node never shows the previous node's value; `commit`
 * receives the `ok` value. An `onEdit` may carry its own `key` for the undo fold (a row edit folds by
 * row index); a field whose whole draft is one edit's subject passes none and lets its `commit` closure
 * name the key, as the text fields do. Taking the identity here is what removed the silent React `key`
 * requirement: the field used to re-seed only because its caller remembered `key={…}`, a second
 * statement of the same fact that a new call site could forget.
 */
export interface DraftField<D> {
  draft: D;
  error: string | null;
  onEdit: (next: D, key?: EditKey) => void;
}

export function useDraft<D, C>(
  initial: () => D,
  validate: (draft: D) => DraftResult<C>,
  identity: EditKey,
  commit: (value: C, key?: EditKey) => void,
): DraftField<D> {
  const seed = (): { identity: EditKey; draft: D; error: string | null } => ({
    identity,
    draft: initial(),
    error: null,
  });
  const [state, setState] = useState(seed);
  // Adjusting state during render when the prop-like `identity` changes — React's documented pattern,
  // and the one reset both folding and re-seeding now read from.
  if (!sameEditKey(state.identity, identity)) setState(seed());

  const onEdit = (next: D, key?: EditKey): void => {
    const result = validate(next);
    if (!result.ok) {
      setState({ identity, draft: next, error: result.error ?? null });
      return;
    }
    setState({ identity, draft: next, error: null });
    commit(result.value, key);
  };

  return { draft: state.draft, error: state.error, onEdit };
}

/**
 * Hold a single-text field's draft and error, validating every keystroke and committing only a valid
 * value. `initial` seeds the draft (a value or a lazy initializer); `validate` is the pure per-field
 * rule; `identity` is which field this draft belongs to (`edit-key.ts`) — when it changes the draft
 * re-seeds, so selecting another node never shows the previous node's text; `commit` receives the
 * `ok` value.
 */
export function useValidatedDraft<T>(
  initial: string | (() => string),
  validate: (text: string) => DraftResult<T>,
  identity: EditKey,
  commit: (value: T) => void,
): { draft: string; error: string | null; onEdit: (text: string) => void } {
  const field = useDraft<string, T>(typeof initial === "function" ? initial : () => initial, validate, identity, commit);
  // The text field's whole draft is the edit's subject, so its `commit` closure names the fold key.
  return { draft: field.draft, error: field.error, onEdit: (text) => field.onEdit(text) };
}

/**
 * The raw-JSON floor's rule (§ Editors, last row): parse the payload JSON, rebuild the node from its
 * envelope plus the parsed payload, and validate the whole one-node file against the registry. An
 * unparseable, non-object, or registry-invalid draft returns its error and is not committed.
 */
export function validateJsonPayload(node: WorkflowNode, text: string, plugins: WireStepPlugin[]): DraftResult<WorkflowNode> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "The payload must be a JSON object." };
  }
  const next = mergeNodePayload(node, parsed as Record<string, unknown>);
  const trial: WorkflowFile = { format: FORMAT_VERSION, id: crypto.randomUUID(), name: "trial", body: [next] };
  const result = safeParseWorkflowFile(trial, wireToRegistry(plugins));
  return result.success ? { ok: true, value: next } : { ok: false, error: result.errors.join("\n") };
}

/**
 * The input object's rule (§ Input/output wiring): the draft is any JSON value with `${…}` placeholders
 * over the step roots (`config`/`context`). An empty draft or an empty object `{}` means "no input", so
 * the key is dropped; every other value — a bare `${context.x}` whole-string, a literal, an array, a
 * populated object — is kept. An ill-typed placeholder returns its error and is not committed.
 */
export function validateInputDraft(node: WorkflowNode, text: string): DraftResult<WorkflowNode> {
  const parsed = parseInputDraft(text, STEP_ROOTS);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const isEmptyObject =
    parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value) && Object.keys(parsed.value).length === 0;
  const isEmpty = text.trim() === "" || isEmptyObject;
  return { ok: true, value: isEmpty ? dropNodeKey(node, "input") : ({ ...node, input: parsed.value } as WorkflowNode) };
}

/**
 * The file-level **input** seed rule: the workflow's own default root context seed, sent on launch when
 * the operator supplies no override. It is a plain JSON **object** — the root context is seeded from its
 * top-level keys — with no `${…}` interpolation (empty roots: nothing resolves the root seed before it
 * lands in context). An empty draft or an empty object `{}` means "no seed", so the key is dropped; an
 * unparseable, array, or scalar draft returns its error and is not committed, so the file stays
 * strict-valid.
 */
export function validateFileInputDraft(file: WorkflowFile, text: string): DraftResult<WorkflowFile> {
  const dropInput = (): WorkflowFile => withoutKey(file, "input");
  if (text.trim() === "") return { ok: true, value: dropInput() };
  const parsed = parseInputDraft(text, []);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, error: "The workflow input must be a JSON object." };
  }
  if (Object.keys(parsed.value).length === 0) return { ok: true, value: dropInput() };
  return { ok: true, value: { ...file, input: parsed.value as { [key: string]: JsonValue } } };
}

/**
 * The `person-activity` **outputSchema** rule (#487): the field is the JSON Schema object the Complete
 * form is built from (ADR 0040). An empty draft means "no schema" — the key is dropped, and the server
 * then accepts any JSON output. A present draft must parse and be a JSON **object** (`{ … }`), never an
 * array or a scalar — the same shape `findAwaitingNode` keeps and normalises. An unparseable or
 * non-object draft returns its error and is not committed, so the node on the canvas stays strict-valid.
 */
export function validateOutputSchema(node: WorkflowNode, text: string): DraftResult<WorkflowNode> {
  if (text.trim() === "") return { ok: true, value: dropNodeKey(node, "outputSchema") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "The output schema must be a JSON object." };
  }
  return { ok: true, value: setNodeField(node, "outputSchema", parsed) };
}

/**
 * The `while-do` max-iterations rule (§ MaxIterationsField): a run of digits is a literal count (a
 * positive whole number), anything else is checked as a `${config.…}` / `${context.…}` interpolation over
 * the step roots. An empty draft, a count below 1, or an ill-typed interpolation returns its error.
 */
export function validateMaxIterations(text: string): DraftResult<number | string> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, error: "Required — a positive whole number, or a ${config.…} / ${context.…} reference." };
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n < 1) return { ok: false, error: "Must be a positive whole number." };
    return { ok: true, value: n };
  }
  const check = checkInterpolationSyntax(text, STEP_ROOTS);
  if (!check.ok) return { ok: false, error: check.error ?? "Invalid interpolation." };
  return { ok: true, value: text };
}

/** A key→interpolable-value editor row (a publish entry, a file-output entry). */
export interface KeyedRow {
  key: string;
  value: string;
}

/**
 * Build the `key → value` map a row list commits, **only** when every named row's value interpolates over
 * `roots`; otherwise report not-ok so the caller drops the commit and the file stays strict-valid.
 * Unnamed rows (a blank key) are the in-progress ones and are skipped, not failed.
 */
export function validRowsToMap(
  rows: KeyedRow[],
  roots: readonly InterpolationRoot[],
): { ok: true; map: Record<string, string> } | { ok: false } {
  const named = rows.filter((row) => row.key !== "");
  if (named.some((row) => !checkInterpolationSyntax(row.value, roots).ok)) return { ok: false };
  const map: Record<string, string> = {};
  for (const row of named) map[row.key] = row.value;
  return { ok: true, map };
}

/** The row-list editor a keyed-row field renders: the current rows, and the three edits over them. */
export interface KeyedRowsEditor {
  rows: KeyedRow[];
  setRow: (index: number, row: KeyedRow) => void;
  addRow: () => void;
  removeRow: (index: number) => void;
}

/**
 * The stateful **keyed-row editor** protocol behind the pane's `key → ${…}` map fields — the node's
 * `publish` map and the file's `output` map (#369/#370). It holds the rows as a draft and, on every edit,
 * rebuilds the map through `validRowsToMap`, committing **only** when every named row's value
 * interpolates — so an ill-typed `${…}` never reaches the file and the node (or file) on the canvas stays
 * strict-valid. Both fields used to re-spell this dance inline; here it has one home beside the pure guard
 * it wraps.
 *
 * `identity` is the row list's own field (`edit-key.ts`): the list re-seeds when it changes, so another
 * node's publishes never show here, and a row edit's key is that identity plus the row index — so a
 * keystroke run in one row folds to one undo entry (#389) and two rows cannot fold together. Add and
 * remove pass no key: each is its own entry.
 *
 * `commit` receives the built map (possibly empty — the caller decides whether an empty map drops the
 * whole key, which differs for a node vs the file).
 */
export function useKeyedRows(
  initial: () => KeyedRow[],
  roots: readonly InterpolationRoot[],
  identity: EditKey,
  commit: (map: Record<string, string>, key?: EditKey) => void,
): KeyedRowsEditor {
  // The rows are the draft and the built map is the committable value — the protocol's core with a
  // row-index fold key, and a not-ok build that stays silent (the row is mid-edit, not wrong).
  const field = useDraft<KeyedRow[], Record<string, string>>(
    initial,
    (rows) => {
      const built = validRowsToMap(rows, roots);
      return built.ok ? { ok: true, value: built.map } : { ok: false };
    },
    identity,
    commit,
  );

  const writeRows = (next: KeyedRow[], row?: number): void => {
    field.onEdit(next, row === undefined ? undefined : { ...identity, row });
  };

  return {
    rows: field.draft,
    setRow: (index, row) => writeRows(field.draft.map((r, i) => (i === index ? row : r)), index),
    addRow: () => writeRows([...field.draft, { key: "", value: "" }]),
    removeRow: (index) => writeRows(field.draft.filter((_, i) => i !== index)),
  };
}
