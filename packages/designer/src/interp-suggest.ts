import type { Message } from "@path/i18n";
import {
  checkInterpolationSyntax,
  type InterpolationRoot,
  type JsonValue,
  publishKeysOf,
  type WorkflowFile,
  walkNodes,
} from "@path/schema";

/** The pure support for the input-wiring editor (designer-spec § Input/output wiring): the pane
 * validates `${…}` placeholders against the schema's own roots, so it never green-lights one a save
 * would reject. */

/**
 * The concrete dot-paths worth autocompleting: `config.<key>` for the file's own config keys,
 * `context.<key>` for every published key, and the bare `<root>.` prefix for each allowed root.
 * Sorted and de-duplicated; `output` carries no enumerable keys (ADR 0022 sub-7).
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

/** The outcome of parsing an input draft: the parsed object, or the first reason it is not
 * acceptable. */
export type InputParse = { ok: true; value: JsonValue } | { ok: false; error: Message };

/** A JSON parse failure, the parser's own words carried verbatim. */
export function notJson(e: unknown): Message {
  return {
    key: "designer.draft.notJson",
    params: { error: e instanceof Error ? e.message : String(e) },
  };
}

/** The schema's interpolation-syntax verdict as a `Message`, or `null` when the text is valid. */
function interpolationError(result: ReturnType<typeof checkInterpolationSyntax>): Message | null {
  return result.ok ? null : result.error;
}

/** Recursively check every string leaf of a parsed JSON value through the interpolation syntax
 * check. */
function checkInterpolation(value: JsonValue, roots: readonly InterpolationRoot[]): Message | null {
  if (typeof value === "string") return interpolationError(checkInterpolationSyntax(value, roots));
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
 * Parse and validate an input draft: JSON-looking text is parsed and every `${…}` leaf checked;
 * anything else is taken as a raw whole-string interpolation. An invalid draft is reported, never
 * committed.
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
      return { ok: false, error: notJson(e) };
    }
    const error = checkInterpolation(parsed as JsonValue, roots);
    if (error) return { ok: false, error };
    return { ok: true, value: parsed as JsonValue };
  }
  const error = interpolationError(checkInterpolationSyntax(text, roots));
  if (error) return { ok: false, error };
  return { ok: true, value: text };
}
