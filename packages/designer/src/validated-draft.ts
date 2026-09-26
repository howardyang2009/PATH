import type { WireStepPlugin } from "@path/client-core";
import {
  checkInterpolationSyntax,
  FORMAT_VERSION,
  type InterpolationRoot,
  type JsonValue,
  STEP_ROOTS,
  safeParseWorkflowFile,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import { useState } from "react";
import { type EditKey, sameEditKey } from "./edit-key.js";
import { withoutKey } from "./edit-target.js";
import { parseInputDraft } from "./interp-suggest.js";
import { dropNodeKey, mergeNodePayload, setNodeField } from "./node-edit.js";
import { wireToRegistry } from "./open-workflow.js";

/**
 * The **draft → validate → commit** protocol behind the pane's live-validated fields: an author sees an
 * invalid draft, but it is never committed, so the canvas stays strict-valid. `useDraft` is the core.
 */

/**
 * A committable value, or a message to show and not commit. The message is optional: a keyed row
 * mid-edit holds its draft silently.
 */
export type DraftResult<T> = { ok: true; value: T } | { ok: false; error?: string };

/**
 * The protocol's core over a draft `D` validating into `C`; when `identity` changes the draft re-seeds,
 * so selecting another node never shows the previous value.
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
  // Adjusting state during render when the prop-like `identity` changes — React's documented pattern.
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

/** A single-text field as the core over a string: validate every keystroke, commit only a valid value. */
export function useValidatedDraft<T>(
  initial: string | (() => string),
  validate: (text: string) => DraftResult<T>,
  identity: EditKey,
  commit: (value: T) => void,
): { draft: string; error: string | null; onEdit: (text: string) => void } {
  const field = useDraft<string, T>(
    typeof initial === "function" ? initial : () => initial,
    validate,
    identity,
    commit,
  );
  // The text field's whole draft is the edit's subject, so its `commit` closure names the fold key.
  return { draft: field.draft, error: field.error, onEdit: (text) => field.onEdit(text) };
}

/**
 * Parse the payload JSON, rebuild the node from its envelope plus the payload, and validate the whole
 * one-node file against the registry (§ Editors); an invalid draft is not committed.
 */
export function validateJsonPayload(
  node: WorkflowNode,
  text: string,
  plugins: WireStepPlugin[],
): DraftResult<WorkflowNode> {
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
  const trial: WorkflowFile = {
    format: FORMAT_VERSION,
    id: crypto.randomUUID(),
    name: "trial",
    body: [next],
  };
  const result = safeParseWorkflowFile(trial, wireToRegistry(plugins));
  return result.success
    ? { ok: true, value: next }
    : { ok: false, error: result.errors.join("\n") };
}

/**
 * The input object's rule (§ Input/output wiring): any JSON value with `${…}` placeholders over the step
 * roots; empty, or `{}`, drops the key, and an ill-typed placeholder errors.
 */
export function validateInputDraft(node: WorkflowNode, text: string): DraftResult<WorkflowNode> {
  const parsed = parseInputDraft(text, STEP_ROOTS);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const isEmptyObject =
    parsed.value !== null &&
    typeof parsed.value === "object" &&
    !Array.isArray(parsed.value) &&
    Object.keys(parsed.value).length === 0;
  const isEmpty = text.trim() === "" || isEmptyObject;
  return {
    ok: true,
    value: isEmpty
      ? dropNodeKey(node, "input")
      : ({ ...node, input: parsed.value } as WorkflowNode),
  };
}

/**
 * The file-level **input** seed: a plain JSON object with no interpolation. Empty or `{}` drops the key;
 * an unparseable, array, or scalar draft errors.
 */
export function validateFileInputDraft(
  file: WorkflowFile,
  text: string,
): DraftResult<WorkflowFile> {
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
 * The `person-activity` **outputSchema** rule: the JSON Schema object the Complete form is built from
 * (ADR 0040); empty drops the key, and a present draft must parse as a JSON object.
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
 * The `while-do` max-iterations rule: a run of digits is a literal count (at least 1), anything else a
 * `${config.…}` / `${context.…}` interpolation.
 */
export function validateMaxIterations(text: string): DraftResult<number | string> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: "Required — a positive whole number, or a ${config.…} / ${context.…} reference.",
    };
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
 * Build the `key → value` map a row list commits, **only** when every named row's value interpolates
 * over `roots`; unnamed rows are in-progress and are skipped.
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

export interface KeyedRowsEditor {
  rows: KeyedRow[];
  setRow: (index: number, row: KeyedRow) => void;
  addRow: () => void;
  removeRow: (index: number) => void;
}

/**
 * The keyed-row editor behind the pane's `key → ${…}` map fields: every edit commits through
 * `validRowsToMap` only when all named rows interpolate; a row's undo key adds the row index.
 */
export function useKeyedRows(
  initial: () => KeyedRow[],
  roots: readonly InterpolationRoot[],
  identity: EditKey,
  commit: (map: Record<string, string>, key?: EditKey) => void,
): KeyedRowsEditor {
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
    setRow: (index, row) =>
      writeRows(
        field.draft.map((r, i) => (i === index ? row : r)),
        index,
      ),
    addRow: () => writeRows([...field.draft, { key: "", value: "" }]),
    removeRow: (index) => writeRows(field.draft.filter((_, i) => i !== index)),
  };
}
