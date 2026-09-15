import type { JsonValue } from "@path/schema";
import { Ajv, type ErrorObject } from "ajv";

/**
 * Output-schema validation for `POST /complete` (ADR 0040). A `person-activity` node's `outputSchema`
 * is **author-supplied JSON Schema**, not a Zod shape — it lives as data inside `workflow.json`, so it
 * cannot be one of the Zod fragments the rest of PATH validates with. We consume it directly with ajv
 * rather than round-tripping JSON Schema → Zod, which drops keywords the converters do not cover.
 *
 * `strict: false` because the schema is the author's, not ours: an unusual-but-legal keyword must
 * validate, not throw. One shared `Ajv` instance caches compiled schemas across requests.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

/** Valid output, or the ajv issues to hand back in a `400`'s `error.details`. */
export type OutputValidation = { ok: true } | { ok: false; issues: ErrorObject[] | [{ message: string }] };

/**
 * Validate `output` against a node's (already config-interpolated) `outputSchema`. A schema ajv cannot
 * compile — author-supplied and only loosely checked at workflow load — is itself a refusal, reported
 * as one issue so the route can render it the same way it renders a value mismatch.
 */
export function validateOutputSchema(schema: JsonValue, output: JsonValue): OutputValidation {
  let validate;
  try {
    validate = ajv.compile(schema as object);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, issues: [{ message: `outputSchema is not a valid JSON Schema: ${message}` }] };
  }
  if (validate(output)) return { ok: true };
  return { ok: false, issues: validate.errors ?? [] };
}
