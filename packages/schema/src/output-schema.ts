import { Ajv, type ErrorObject } from "ajv";
import type { JsonValue } from "./json-value.js";

/** Lazily built: the instance caches compiled schemas, and a vocabulary-only import never pays for it. */
let ajv: Ajv | undefined;

/** Valid output, or the ajv issues for a caller to render — a `400`'s `error.details`, or field errors. */
export type OutputValidation =
  | { ok: true }
  | { ok: false; issues: (ErrorObject | { message: string })[] };

/** Validate `output` against an already config-interpolated `outputSchema`; `strict: false` because the
 * schema is the author's, and a schema ajv cannot compile is itself a refusal issue. */
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
