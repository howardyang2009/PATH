import {
  checkInterpolationSyntax,
  type InterpolationRoot,
  type JsonValue,
  publishKeysOf,
  type WorkflowFile,
  walkNodes,
} from "@path/schema";

/** The pure support for the input-wiring editor (designer-spec § Input/output wiring): the pane validates
 * `${…}` placeholders against the schema's own roots, so it never green-lights one a save would reject. */

/**
 * The concrete dot-paths worth autocompleting: `config.<key>` for the file's own config keys,
 * `context.<key>` for every published key, and the bare `<root>.` prefix for each allowed root. Sorted
 * and de-duplicated; `output` carries no enumerable keys (ADR 0022 sub-7).
 */
export function referenceablePaths(
  file: WorkflowFile,
  roots: readonly InterpolationRoot[],
): string[] {
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
export type InputParse = { ok: true; value: JsonValue } | { ok: false; error: string };

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
 * Parse and validate an input draft: JSON-looking text is parsed and every `${…}` leaf checked; anything
 * else is taken as a raw whole-string interpolation. An invalid draft is reported, never committed.
 */
export function parseInputDraft(text: string, roots: readonly InterpolationRoot[]): InputParse {
  const trimmed = text.trim();
  const looksStructured =
    /^[[{"]/.test(trimmed) ||
    /^-?\d/.test(trimmed) ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null";
  if (looksStructured) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    const error = checkInterpolation(parsed as JsonValue, roots);
    if (error) return { ok: false, error };
    return { ok: true, value: parsed as JsonValue };
  }
  const check = checkInterpolationSyntax(text, roots);
  if (!check.ok) return { ok: false, error: check.error ?? "invalid interpolation" };
  return { ok: true, value: text };
}
