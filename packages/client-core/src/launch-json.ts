import type { Message } from "@path/i18n";
import { verbatim } from "@path/i18n";
import type { JsonValue } from "@path/schema";

/** The result of gating one raw-JSON launch field (`input`/`config`); `empty` separates "blank, and
 * that is fine" (send nothing) from "blank, and not allowed" (block). A refusal is a `Message`, so
 * the lint reads in the active Locale (ADR 0107).
 */
export type JsonFieldResult =
  | { ok: true; empty: true; value: undefined }
  | { ok: true; empty: false; value: Record<string, JsonValue> }
  | { ok: false; empty: boolean; message: Message };

export interface ParseJsonFieldOptions {
  /** Whether blank text is a valid "omit this field" (`input`/`config` are both optional on the
   * wire). */
  allowEmpty: boolean;
}

/** Parse and shape-check one launch field client-side, deliberately shallow: valid JSON, and the
 * object the wire declares. The server stays the real validator (a rejected `$env` override, ADR
 * 0012) and its `400` is what surfaces.
 */
export function parseJsonField(
  text: string,
  { allowEmpty }: ParseJsonFieldOptions,
): JsonFieldResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return allowEmpty
      ? { ok: true, empty: true, value: undefined }
      : { ok: false, empty: true, message: { key: "shared.jsonField.required" } };
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(trimmed) as JsonValue;
  } catch (error) {
    // The parser's text is not PATH's to translate, so it rides verbatim in the sentence (ADR 0107).
    return {
      ok: false,
      empty: false,
      message: {
        key: "shared.jsonField.invalidJson",
        params: { error: verbatim(error instanceof Error ? error.message : "invalid JSON") },
      },
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, empty: false, message: { key: "shared.jsonField.notAnObject" } };
  }
  return { ok: true, empty: false, value: parsed as Record<string, JsonValue> };
}
