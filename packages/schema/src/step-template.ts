import { z } from "zod";
import { formatIssues } from "./format-issues.js";
import { IdSchema } from "./ids.js";
import { makeBodySchema, supersededFormatError } from "./workflow-file.js";
import { FORMAT_VERSION } from "./workflow-file-type.js";
import type { StepPluginRegistry } from "./nodes.js";
import type { StepTemplate } from "./step-template-type.js";

// The strict Step-Template envelope (ADR 0048 decision 1): `{ format, id, description, body }` and
// nothing else. `.strict()` is the whole point of the shape — a `name`, a `worker_defaults`, a
// `config`/`input`/`output` seed, or any file-level key is rejected, because a template is a fragment
// and carries none of the file namespace. The envelope is frozen and unversioned; a new key here is a
// change to *this* schema, never a `format` bump. `format` stamps the body grammar (`path/workflow@5`).
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
 * The whole `StepTemplateSchema` for a given registry (ADR 0048 decision 7). The strict envelope wraps
 * the shared body validator `makeBodySchema(registry)`, so a template's body is validated *exactly* as
 * a file's body — one `z.array(nodeSchema).min(1)`, one node union. Validity is per-node and
 * registry-relative and **nothing else** (decision 5): name uniqueness is the target file's namespace,
 * the publish set re-runs on the file the fragment lands in, and there is no node-count bound. A
 * relative `workflow` ref is allowed — it resolves against the target file at instantiation, not here
 * (decision 6). Build once per freeze; parse many templates with `safeParseStepTemplateWith`.
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

// The superseded-format pre-check and success/failure shaping, against an already-built schema. The
// `format` stamp versions the body grammar, so a template carrying `@0`/`@1`/`@2`/`@3` hits the same
// codemod machinery a file does (workflow-file.ts's `supersededFormatError`): a `@2`-stamped envelope
// names the body grammar this map's tickets discuss but is not loadable, and gets the "run the codemod"
// message rather than a generic `.strict()`/`format` mismatch (ADR 0048 decision 1).
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

// The single-template convenience door: build the strict envelope for `registry` and parse `json`. The
// registry is required — there is no closed built-in schema (ADR 0019). A caller parsing many templates
// should build once with `makeStepTemplateSchema` and reuse it via `safeParseStepTemplateWith`.
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
