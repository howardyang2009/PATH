import type { JsonValue } from "@path/schema";

/**
 * The Complete form model (ADR 0040, CONTEXT.md § Person-activity): a `person-activity` node's
 * `outputSchema` is author-supplied JSON Schema, and both the Viewer and the Designer build the
 * completion form from it. This is the framework-free half of that build — the field list, the value
 * coercion, the client pre-check, and the mapping of the server's ajv `400` back onto fields — so the
 * two surfaces draw the same form and read the same errors, with only the inputs left to each.
 *
 * The server is always the authority (it re-validates against the current file). The client pre-check
 * is a courtesy that catches the obvious before a round-trip; a passing pre-check is never a promise,
 * so a `400` still lands and its field errors show.
 */

/** How one property is drawn and typed. `enum` collapses any typed enum to a select of its labels. */
export type CompleteFieldKind = "boolean" | "enum" | "number" | "integer" | "string";

export interface CompleteField {
  /** The property name — the output object key and the form control id. */
  key: string;
  /** The label: the schema's `title`, else the key. */
  title: string;
  /** The schema's `description`, shown as field help; `null` when absent. */
  description: string | null;
  kind: CompleteFieldKind;
  /** In the schema's `required` array. */
  required: boolean;
  /** The allowed values for an `enum` field, else `null`. */
  enum: string[] | null;
  /** A string field the author marked `"format": "textarea"` — rendered as a textarea. */
  multiline: boolean;
}

/** The value a form control holds before coercion: a checkbox's boolean, or any other control's text. */
export type CompleteFieldValue = string | boolean;

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldKind(prop: { [key: string]: JsonValue }): { kind: CompleteFieldKind; enumValues: string[] | null } {
  if (Array.isArray(prop.enum)) {
    return { kind: "enum", enumValues: prop.enum.map((value) => String(value)) };
  }
  if (prop.type === "boolean") return { kind: "boolean", enumValues: null };
  if (prop.type === "number") return { kind: "number", enumValues: null };
  if (prop.type === "integer") return { kind: "integer", enumValues: null };
  return { kind: "string", enumValues: null };
}

/**
 * The fields to draw for an `outputSchema`, in the schema's property order. A `null` schema (a node
 * with none) returns no fields — the form is then a bare "submit" over an empty output, which the
 * server accepts as any JSON. A schema that is not an object-with-properties also yields no fields.
 */
export function buildCompleteFields(outputSchema: JsonValue | null): CompleteField[] {
  if (!isJsonObject(outputSchema) || !isJsonObject(outputSchema.properties)) return [];
  const required = new Set(Array.isArray(outputSchema.required) ? outputSchema.required.map((v) => String(v)) : []);
  const fields: CompleteField[] = [];
  for (const [key, raw] of Object.entries(outputSchema.properties)) {
    if (!isJsonObject(raw)) continue;
    const { kind, enumValues } = fieldKind(raw);
    fields.push({
      key,
      title: typeof raw.title === "string" ? raw.title : key,
      description: typeof raw.description === "string" ? raw.description : null,
      kind,
      required: required.has(key),
      enum: enumValues,
      multiline: kind === "string" && raw.format === "textarea",
    });
  }
  return fields;
}

/**
 * The output a schema-less node's raw control makes (ADR 0040: no `outputSchema` ⇒ any JSON is
 * accepted). It never rejects — the person can type anything:
 *
 * - blank ⇒ an empty object `{}`, the historical "bare submit" so a node that wants nothing back still
 *   completes with one click;
 * - text that parses as JSON ⇒ that JSON value (a number, a boolean, an array, an object), so a
 *   structured output is still possible;
 * - anything else ⇒ the text itself, as a JSON string. So `done` submits `"done"`, not a parse error —
 *   a schema-less step takes plain prose as readily as JSON, which is what `${output}` then carries.
 */
export function coerceRawCompleteOutput(text: string): JsonValue {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return trimmed;
  }
}

/**
 * The output object a set of control values makes: a boolean field's value verbatim, a number field
 * parsed (blank omitted), any other field trimmed (blank omitted). An omitted field is left off the
 * object rather than sent as `null`/`""`, so a `required` check reads the same as the server's.
 */
export function coerceCompleteOutput(
  fields: CompleteField[],
  values: Partial<Record<string, CompleteFieldValue>>,
): { [key: string]: JsonValue } {
  const output: { [key: string]: JsonValue } = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (field.kind === "boolean") {
      output[field.key] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") continue;
    if (field.kind === "number" || field.kind === "integer") {
      output[field.key] = Number(text);
    } else {
      output[field.key] = text;
    }
  }
  return output;
}

/**
 * The client pre-check: required fields present, enum values in range, number fields numeric. Returns
 * per-field messages keyed by field key ({} when clean). Mirrors what ajv refuses at the server
 * (ADR 0040) for the common cases; the server stays the authority for the rest.
 */
export function validateCompleteOutput(
  fields: CompleteField[],
  output: { [key: string]: JsonValue },
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = output[field.key];
    const present = value !== undefined && value !== "";
    if (field.required && !present) {
      errors[field.key] = "This field is required.";
      continue;
    }
    if (!present) continue;
    if (field.kind === "enum" && field.enum && !field.enum.includes(String(value))) {
      errors[field.key] = `Must be one of: ${field.enum.join(", ")}.`;
    } else if ((field.kind === "number" || field.kind === "integer") && !Number.isFinite(value as number)) {
      errors[field.key] = "Must be a number.";
    } else if (field.kind === "integer" && !Number.isInteger(value as number)) {
      errors[field.key] = "Must be a whole number.";
    }
  }
  return errors;
}

/** The Complete route's `400` decoded onto the form: per-field messages plus any form-level ones. */
export interface MappedCompleteErrors {
  fieldErrors: Record<string, string>;
  formErrors: string[];
}

/**
 * Map the ajv issues the Complete route returns in a `400`'s `error.details` (`output-schema.ts`) onto
 * the form. A `required` issue names its field in `params.missingProperty`; every other issue names its
 * field in `instancePath` (`/reviewer` → `reviewer`). An issue that names no field — the top-level
 * `required` aside, a schema that would not compile — lands at the form level. Messages are shown
 * **verbatim** (the AC's "the server's field errors"); the server is the authority on the wording.
 */
export function mapCompleteErrors(details: JsonValue | undefined): MappedCompleteErrors {
  const fieldErrors: Record<string, string> = {};
  const formErrors: string[] = [];
  if (!Array.isArray(details)) return { fieldErrors, formErrors };
  for (const raw of details) {
    if (!isJsonObject(raw)) continue;
    const message = typeof raw.message === "string" ? raw.message : "Invalid value.";
    const key = fieldKeyOf(raw);
    if (key === null) formErrors.push(message);
    else if (fieldErrors[key] === undefined) fieldErrors[key] = message;
  }
  return { fieldErrors, formErrors };
}

/** The field an ajv issue is about, or `null` for a form-level one. */
function fieldKeyOf(issue: { [key: string]: JsonValue }): string | null {
  if (issue.keyword === "required" && isJsonObject(issue.params) && typeof issue.params.missingProperty === "string") {
    return issue.params.missingProperty;
  }
  if (typeof issue.instancePath === "string" && issue.instancePath.startsWith("/")) {
    const segment = issue.instancePath.slice(1).split("/")[0];
    return segment !== undefined && segment !== "" ? decodeJsonPointer(segment) : null;
  }
  return null;
}

/** Undo the two JSON-Pointer escapes ajv writes in an `instancePath` segment (RFC 6901). */
function decodeJsonPointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
