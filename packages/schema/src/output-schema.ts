import { Ajv, type ErrorObject } from "ajv";
import type { JsonValue } from "./json-value.js";

/**
 * `outputSchema` validation for a **person-activity** completion (ADR 0040), stated once for the two
 * places that run it: the Complete route, which refuses the submit, and the browser's Complete form,
 * whose pre-check used to be a hand-rolled partial mirror of this rule — required, enum and number
 * only, so a `pattern`, `minimum`, `minLength` or nested-object constraint passed the form and came
 * back as a `400`. Two adapters, one interface, one validator.
 *
 * A node's `outputSchema` is **author-supplied JSON Schema**, not a Zod shape: it lives as data inside
 * `workflow.json`, so it cannot be one of the Zod fragments the rest of PATH validates with. We consume
 * it directly with ajv rather than round-tripping JSON Schema → Zod, which drops keywords the converters
 * do not cover.
 *
 * `strict: false` because the schema is the author's, not ours: an unusual-but-legal keyword must
 * validate, not throw. The `Ajv` instance caches compiled schemas between calls and is built **lazily**,
 * so a surface that imports `@path/schema` for its vocabulary alone never pays for a validator.
 */
let ajv: Ajv | undefined;

/** Valid output, or the ajv issues for a caller to render — a `400`'s `error.details`, or field errors. */
export type OutputValidation =
  | { ok: true }
  | { ok: false; issues: (ErrorObject | { message: string })[] };

/**
 * Validate `output` against an (already config-interpolated) `outputSchema`. A schema ajv cannot
 * compile — author-supplied and only loosely checked at workflow load — is itself a refusal, reported
 * as one issue so every reader renders it the same way it renders a value mismatch.
 */
export function validateOutputSchema(schema: JsonValue, output: JsonValue): OutputValidation {
  ajv ??= new Ajv({ allErrors: true, strict: false });
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema as object);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      issues: [{ message: `outputSchema is not a valid JSON Schema: ${message}` }],
    };
  }
  if (validate(output)) return { ok: true };
  return { ok: false, issues: validate.errors ?? [] };
}
