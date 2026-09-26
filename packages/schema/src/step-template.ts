import { z } from "zod";
import { formatIssues } from "./format-issues.js";
import { IdSchema } from "./ids.js";
import type { StepPluginRegistry } from "./nodes.js";
import type { StepTemplate } from "./step-template-type.js";
import { makeBodySchema, supersededFormatError } from "./workflow-file.js";
import { FORMAT_VERSION } from "./workflow-file-type.js";

// The strict Step-Template envelope (ADR 0048): `{ format, id, description, body }` and nothing else.
// A fragment carries no file namespace, so any file-level key is rejected; `format` stamps the body grammar.
function buildStepTemplateSchema(bodySchema: z.ZodType<StepTemplate["body"]>) {
  return z
    .object({
      format: z.literal(FORMAT_VERSION),
      id: IdSchema,
      description: z.string().min(1, "description must be a non-empty string"),
      body: bodySchema,
    })
    .strict();
}

/**
 * The whole envelope for a registry, wrapping the shared `makeBodySchema(registry)`, so a template's
 * body validates exactly as a file's body. Validity is per-node and registry-relative and nothing else:
 * name uniqueness and the publish set belong to the target file, and a relative `workflow` ref resolves there.
 */
export function makeStepTemplateSchema(registry: StepPluginRegistry): z.ZodType<StepTemplate> {
  return buildStepTemplateSchema(makeBodySchema(registry)) as z.ZodType<StepTemplate>;
}

export interface StepTemplateParseSuccess {
  success: true;
  data: StepTemplate;
}

export interface StepTemplateParseFailure {
  success: false;
  errors: string[];
}

// The superseded-format pre-check and success/failure shaping. A `format` stamp of `@0`–`@3` hits the
// same codemod machinery a file does, so it gets the "run the codemod" message, not a generic mismatch.
export function safeParseStepTemplateWith(
  schema: z.ZodType<StepTemplate>,
  json: unknown,
): StepTemplateParseSuccess | StepTemplateParseFailure {
  const superseded = supersededFormatError(json);
  if (superseded) return superseded;
  const result = schema.safeParse(json);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatIssues(result.error) };
}

// The single-template convenience door; the registry is required, since there is no closed built-in
// schema (ADR 0019). A caller parsing many templates should build once and reuse the schema.
export function safeParseStepTemplate(
  json: unknown,
  registry: StepPluginRegistry,
): StepTemplateParseSuccess | StepTemplateParseFailure {
  return safeParseStepTemplateWith(makeStepTemplateSchema(registry), json);
}

export function parseStepTemplate(json: unknown, registry: StepPluginRegistry): StepTemplate {
  const result = safeParseStepTemplate(json, registry);
  if (!result.success) {
    throw new Error(`invalid step template:\n${result.errors.join("\n")}`);
  }
  return result.data;
}
