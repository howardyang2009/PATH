import { useState } from "react";
import type { WireStepPlugin } from "@path/client-core";
import {
  FORMAT_VERSION,
  STEP_ROOTS,
  checkInterpolationSyntax,
  safeParseWorkflowFile,
  type InterpolationRoot,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import { dropNodeKey, mergeNodePayload } from "./node-edit.js";
import { parseInputDraft } from "./interp-suggest.js";
import { wireToRegistry } from "./open-workflow.js";

/**
 * The one **draft → validate → commit** protocol behind the properties pane's live-validated fields
 * (#369/#370, designer-spec § Editors, § Input/output wiring, § Context reads and writes). The rule the
 * pane must never break: an author sees a draft while it is invalid, but an invalid draft is **never
 * committed**, so the node (or file) on the canvas stays strict-valid — only the editor's fidelity
 * degrades. That rule used to be re-spelled in each field. Here it has one home in two shapes:
 *
 * - **`useValidatedDraft`** — the hook for a single-text field (the raw-JSON floor, the input object, the
 *   max-iterations line). It holds the draft and the error, runs a pure `validate` on each keystroke, and
 *   commits only the `ok` value.
 * - **`validRowsToMap`** — the pure guard for a key→value row list (the publish map, the file output
 *   map): it builds the map only when every named row's value interpolates, else reports not-ok so the
 *   caller drops the commit.
 *
 * The `validate*` functions are pure and unit-tested directly, off the pane's render path.
 */

/** The outcome of validating one draft: a committable value, or a message to show and not commit. */
export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Hold a single-text field's draft and error, validating every keystroke and committing only a valid
 * value. `initial` seeds the draft (a value or a lazy initializer); `validate` is the pure per-field
 * rule; `commit` receives the `ok` value (the field closes its own coalesce key over this). The returned
 * `onEdit` is the textarea/input `onChange` handler; `error` drives the field's `aria-invalid` + message.
 */
export function useValidatedDraft<T>(
  initial: string | (() => string),
  validate: (text: string) => DraftResult<T>,
  commit: (value: T) => void,
): { draft: string; error: string | null; onEdit: (text: string) => void } {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const onEdit = (text: string): void => {
    setDraft(text);
    const result = validate(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    commit(result.value);
  };

  return { draft, error, onEdit };
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
