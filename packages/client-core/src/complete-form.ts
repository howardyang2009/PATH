import { isPlainObject, type JsonValue, validateOutputSchema } from "@path/schema";

/** The Complete form model (ADR 0040, CONTEXT.md § Person-activity): the field list, value coercion, client pre-check,
 * and the mapping of the server's ajv `400` onto fields, shared by the Viewer and the Designer.
 */

/** How one property is drawn and typed. `enum` collapses any typed enum to a select of its labels. */
export type CompleteFieldKind = "boolean" | "enum" | "number" | "integer" | "string";

export interface CompleteField {
  /** The property name — the output object key and the form control id. */
  key: string;
  title: string;
  /** The schema's `description`, shown as field help. */
  description: string | null;
  kind: CompleteFieldKind;
  required: boolean;
  /** The allowed values for an `enum` field. */
  enum: string[] | null;
  /** A string field the author marked `"format": "textarea"` — rendered as a textarea. */
  multiline: boolean;
}

/** The value a form control holds before coercion: a checkbox's boolean, or any other control's text. */
export type CompleteFieldValue = string | boolean;

function fieldKind(prop: { [key: string]: JsonValue }): {
  kind: CompleteFieldKind;
  enumValues: string[] | null;
} {
  if (Array.isArray(prop.enum)) {
    return { kind: "enum", enumValues: prop.enum.map((value) => String(value)) };
  }
  if (prop.type === "boolean") return { kind: "boolean", enumValues: null };
  if (prop.type === "number") return { kind: "number", enumValues: null };
  if (prop.type === "integer") return { kind: "integer", enumValues: null };
  return { kind: "string", enumValues: null };
}

/** The fields to draw for an `outputSchema`, in the schema's property order; a `null` or property-less schema yields
 * none.
 */
export function buildCompleteFields(outputSchema: JsonValue | null): CompleteField[] {
  if (!isPlainObject(outputSchema) || !isPlainObject(outputSchema.properties)) return [];
  const required = new Set(
    Array.isArray(outputSchema.required) ? outputSchema.required.map((v) => String(v)) : [],
  );
  const fields: CompleteField[] = [];
  for (const [key, raw] of Object.entries(outputSchema.properties)) {
    if (!isPlainObject(raw)) continue;
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

/** The output a schema-less node's raw control makes (ADR 0040: no `outputSchema` ⇒ any JSON accepted), never
 * rejecting: blank ⇒ `{}`, text parsing as JSON ⇒ that value, anything else ⇒ the text as a JSON string.
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

/** The output object a set of control values makes: booleans verbatim, numbers parsed, other fields trimmed; a blank
 * field is omitted rather than sent as `null`/`""`, so a `required` check matches the server's.
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

/** The client pre-check, run with the very validator the Complete route runs (ADR 0040). The server is always the
 * authority; a passing pre-check is a courtesy, never a promise.
 */
export function validateCompleteDraft(
  outputSchema: JsonValue | null,
  output: JsonValue,
): MappedCompleteErrors {
  if (outputSchema === null) return { fieldErrors: {}, formErrors: [] };
  // Validate the bytes the route will see, not the in-memory value: serializing turns a `NaN` (a number
  // field the person typed text into) into `null`, so the pre-check reaches the route's verdict.
  const wire = JSON.parse(JSON.stringify(output)) as JsonValue;
  const validation = validateOutputSchema(outputSchema, wire);
  return validation.ok
    ? { fieldErrors: {}, formErrors: [] }
    : mapCompleteErrors(validation.issues as unknown as JsonValue);
}

/** The Complete route's `400` decoded onto the form: per-field messages plus any form-level ones. */
export interface MappedCompleteErrors {
  fieldErrors: Record<string, string>;
  formErrors: string[];
}

/** Map the route's ajv issues onto the form: a `required` issue names its field in `params.missingProperty`, every
 * other in `instancePath`; one naming no field lands at the form level. Messages are shown **verbatim** — the server
 * owns the wording.
 */
export function mapCompleteErrors(details: JsonValue | undefined): MappedCompleteErrors {
  const fieldErrors: Record<string, string> = {};
  const formErrors: string[] = [];
  if (!Array.isArray(details)) return { fieldErrors, formErrors };
  for (const raw of details) {
    if (!isPlainObject(raw)) continue;
    const message = typeof raw.message === "string" ? raw.message : "Invalid value.";
    const key = fieldKeyOf(raw);
    if (key === null) formErrors.push(message);
    else if (fieldErrors[key] === undefined) fieldErrors[key] = message;
  }
  return { fieldErrors, formErrors };
}

/** The field an ajv issue is about, or `null` for a form-level one. */
function fieldKeyOf(issue: { [key: string]: JsonValue }): string | null {
  if (
    issue.keyword === "required" &&
    isPlainObject(issue.params) &&
    typeof issue.params.missingProperty === "string"
  ) {
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
