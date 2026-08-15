import type { JsonValue } from "@path/client-core";

/**
 * The result of gating one raw-JSON launch field (`input` or `config`, issue #233 variant A).
 * `empty` distinguishes "blank, and that is fine" (an omitted optional field) from "blank, and that
 * is not allowed" — the form sends nothing for the first and blocks on the second.
 */
export type JsonFieldResult =
  | { ok: true; empty: true; value: undefined }
  | { ok: true; empty: false; value: Record<string, JsonValue> }
  | { ok: false; empty: boolean; message: string };

export interface ParseJsonFieldOptions {
  /** Whether blank text is a valid "omit this field" (`input`/`config` are both optional on the wire). */
  allowEmpty: boolean;
}

/**
 * Parse and shape-check one launch field, client-side, before a request is spent. Deliberately
 * shallow: it proves the text is valid JSON and is the object the wire declares (`input` is a
 * `record`, `config` a `ConfigObject`), and stops there. The server remains the real validator — a
 * rejected `$env` override (ADR 0012), an input that fails the worker's own expectations, an
 * unfound `workflow_path` — and those come back as a `400` the form surfaces (#233). Reimplementing
 * that here would be a second, drifting copy of the contract.
 */
export function parseJsonField(text: string, { allowEmpty }: ParseJsonFieldOptions): JsonFieldResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return allowEmpty
      ? { ok: true, empty: true, value: undefined }
      : { ok: false, empty: true, message: "required — type {} to send none" };
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(trimmed) as JsonValue;
  } catch (error) {
    return { ok: false, empty: false, message: error instanceof Error ? error.message : "invalid JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, empty: false, message: "must be a JSON object, e.g. {}" };
  }
  return { ok: true, empty: false, value: parsed as Record<string, JsonValue> };
}
