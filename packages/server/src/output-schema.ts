import { validateOutputSchema as validateWithSchema, type JsonValue, type OutputValidation as SharedValidation } from "@path/schema";

/**
 * Output-schema validation for `POST /complete` (ADR 0040).
 *
 * The rule itself lives in `@path/schema` (`output-schema.ts`), because two adapters enforce one
 * interface: this route, which refuses an invalid submit with a `400` carrying the ajv issues, and the
 * browser's Complete form, which pre-checks the same output against the same schema. The form used to
 * run a hand-rolled partial mirror — required, enum and number only — so a `pattern`, `minimum`,
 * `minLength` or nested-object constraint passed the form and came back a `400`; both now read the one
 * validator, and a schema that will not compile is reported the same way to both.
 */
export type OutputValidation = SharedValidation;

export function validateOutputSchema(schema: JsonValue, output: JsonValue): OutputValidation {
  return validateWithSchema(schema, output);
}
