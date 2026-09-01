import {
  checkInterpolationSyntax,
  walkNodes,
  type InterpolationRoot,
  type JsonValue,
  type WorkflowFile,
} from "@path/schema";
import { publishKeysOf } from "./publish-conflicts.js";

/**
 * The pure support for the input-wiring editor (#370, designer-spec § Input/output wiring). A step's one
 * input is an interpolable JSON **object**: `${…}` placeholders reference dot-paths, authored with path
 * autocomplete and validated live by `checkInterpolationSyntax` — an unclosed or ill-typed placeholder
 * is rejected in the pane, the structural analogue of the unsnappable socket. There is no node-to-node
 * wire on the canvas.
 *
 * The live check runs against the **same roots the schema enforces** for the field (`STEP_ROOTS` for an
 * input), so what the pane accepts is exactly what a load-time parse accepts — the pane never green-lights
 * a placeholder a save would reject. The autocomplete offers the same roots, plus the concrete keys the
 * file makes referenceable, so a suggestion is never one the check would then refuse.
 */

/**
 * The concrete dot-paths worth autocompleting for an interpolable field, given its allowed roots:
 * - `config.<key>` for every key the file's own `config` declares;
 * - `context.<key>` for every key any step in the file `publish`es (what a `${context.x}` read resolves);
 * - the bare `<root>.` prefix for every allowed root, so an author can start a path the file has no key
 *   for yet (an `output.` read of a not-yet-authored predecessor output).
 *
 * Sorted and de-duplicated. `output` carries no enumerable keys — a predecessor's output shape is
 * author-trust, not statically known (ADR 0022 sub-7) — so it contributes only its prefix.
 */
export function referenceablePaths(file: WorkflowFile, roots: readonly InterpolationRoot[]): string[] {
  const out = new Set<string>();
  for (const root of roots) out.add(`${root}.`);

  if (roots.includes("config")) {
    for (const key of Object.keys(file.config ?? {})) out.add(`config.${key}`);
  }
  if (roots.includes("context")) {
    for (const node of walkNodes(file.body)) {
      for (const key of publishKeysOf(node)) out.add(`context.${key}`);
    }
  }
  return [...out].sort();
}

/** The outcome of parsing an input draft: the parsed object, or the first reason it is not acceptable. */
export type InputParse = { ok: true; value: { [key: string]: JsonValue } } | { ok: false; error: string };

/** Recursively check every string leaf of a parsed JSON value through the interpolation syntax check. */
function checkInterpolation(value: JsonValue, roots: readonly InterpolationRoot[]): string | null {
  if (typeof value === "string") {
    const result = checkInterpolationSyntax(value, roots);
    return result.ok ? null : (result.error ?? "invalid interpolation");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = checkInterpolation(item, roots);
      if (error) return error;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      const error = checkInterpolation(item, roots);
      if (error) return error;
    }
    return null;
  }
  return null;
}

/**
 * Parse and validate an input-object draft against the field's roots: it must be valid JSON, a JSON
 * object (the step's one input object), and every `${…}` placeholder in it must pass the interpolation
 * check. Mirrors the raw-JSON floor's discipline (#369): an invalid draft is reported and never
 * committed, so the node stays strict-valid.
 */
export function parseInputDraft(text: string, roots: readonly InterpolationRoot[]): InputParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "The input must be a JSON object." };
  }
  const error = checkInterpolation(parsed as JsonValue, roots);
  if (error) return { ok: false, error };
  return { ok: true, value: parsed as { [key: string]: JsonValue } };
}
