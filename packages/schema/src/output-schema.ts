import type { ErrorCode } from "@path/i18n";
import { Ajv, type ErrorObject } from "ajv";
import { codedIssue } from "./coded-issue.js";
import type { JsonValue } from "./json-value.js";

/** Lazily built: the instance caches compiled schemas, and a vocabulary-only import never pays for
 * it. */
let ajv: Ajv | undefined;

/** An issue PATH owns among the ajv ones: English `message`, plus the code and params a client
 * renders (ADR 0107). */
export interface CodedOutputIssue {
  message: string;
  code: ErrorCode;
  params: Record<string, string>;
}

/** Valid output, or the ajv issues for a caller to render — a `400`'s `error.details`, or field
 * errors. */
export type OutputValidation =
  | { ok: true }
  | { ok: false; issues: (ErrorObject | CodedOutputIssue)[] };

/** Validate `output` against an already config-interpolated `outputSchema`; `strict: false` because
 * the schema is the author's, and a schema ajv cannot compile is itself a refusal issue. */
export function validateOutputSchema(schema: JsonValue, output: JsonValue): OutputValidation {
  ajv ??= new Ajv({ allErrors: true, strict: false });
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema as object);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const { message } = codedIssue("schema.output-schema.invalid", { reason });
    return {
      ok: false,
      issues: [{ message, code: "schema.output-schema.invalid", params: { reason } }],
    };
  }
  if (validate(output)) return { ok: true };
  return { ok: false, issues: validate.errors ?? [] };
}
