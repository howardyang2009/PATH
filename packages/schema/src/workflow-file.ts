import { z } from "zod";
import { ConfigObjectSchema } from "./config.js";
import { formatIssues } from "./format-issues.js";
import { gotoIssues } from "./goto.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolatedJsonValue } from "./interpolation.js";
import { nodeIdentityIssues } from "./node-identity.js";
import type { WorkflowNode } from "./node-type.js";
import { makeNodeSchema, type StepPluginRegistry } from "./nodes.js";
import { publishSetIssues } from "./publish-set.js";
import { STEP_ROOTS } from "./roots.js";
import { collectWorkerDefaultIssues } from "./worker-defaults.js";
import {
  FORMAT_VERSION,
  SUPERSEDED_FORMAT_VERSIONS,
  type WorkflowFile,
} from "./workflow-file-type.js";

export { FORMAT_VERSION };

// The file envelope is parameterised by its `body` schema; everything except `body` is fixed grammar,
// and there is no closed built-in envelope — a file is only ever parsed against a registry (ADR 0019).
function buildBaseWorkflowFileSchema(bodySchema: z.ZodType<WorkflowNode[]>) {
  return z
    .object({
      format: z.literal(FORMAT_VERSION),
      id: IdSchema,
      name: NameSchema,
      config: ConfigObjectSchema.optional(),
      // The file's launch seed: the JSON object a launch sends as root input when the operator gives no
      // override. Plain JSON — the empty root set refuses a `${…}` placeholder here (format doc §6.3).
      input: z.record(z.string(), interpolatedJsonValue([])).optional(),
      body: bodySchema,
      output: z.record(z.string(), interpolatedJsonValue(STEP_ROOTS)).optional(),
      // The file worker-default table (ADR 0044): shape only — registry-relative validity is an engine-load check.
      worker_defaults: z.record(z.string().min(1), z.string().min(1)).optional(),
    })
    .strict();
}

// The file channel of ADR 0044's registry-relative `worker_defaults` validation: each bad entry makes
// the file invalid (ADR 0026), reported at its own `worker_defaults.<type>` path, aggregated in one pass.
function checkWorkerDefaults(
  file: WorkflowFile,
  ctx: z.RefinementCtx,
  registry: StepPluginRegistry,
): void {
  if (!file.worker_defaults) return;
  for (const { type, message } of collectWorkerDefaultIssues(file.worker_defaults, registry)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["worker_defaults", type], message });
  }
}

// The cross-node invariants zod's per-field parse cannot express: file-unique names, the publish set,
// every goto's placement and first-level target (docs/spec/goto.md §2.3), and `worker_defaults` (ADR 0044).
function checkWorkflowFileInvariants(
  file: WorkflowFile,
  ctx: z.RefinementCtx,
  registry: StepPluginRegistry,
): void {
  // The identity rule is `node-identity.ts`'s; `duplicate-name` is the one rule the load enforces (ADR 0015).
  for (const issue of nodeIdentityIssues(file, ["duplicate-name"])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...issue.path, "name"],
      message: `duplicate name "${String(issue.value)}": names must be unique across the whole file`,
    });
  }

  for (const issue of publishSetIssues(file)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }

  for (const issue of gotoIssues(file)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }

  checkWorkerDefaults(file, ctx, registry);
}

/**
 * The body validator (ADR 0048 decision 7): `z.array(nodeSchema).min(1)` over `makeNodeSchema(registry)`,
 * the one constraint a file body and a Step-Template body share. The cross-node file rules are the file
 * namespace's, not the body's (decision 5), so a fragment need not know where it will land.
 */
export function makeBodySchema(registry: StepPluginRegistry): z.ZodType<WorkflowNode[]> {
  const nodeSchema = makeNodeSchema(registry);
  return z.array(nodeSchema).min(1) as unknown as z.ZodType<WorkflowNode[]>;
}

/**
 * The whole `WorkflowFileSchema` for a registry (ADR 0018 sub-7): the file envelope wrapping the open
 * node union, plus the file-scoped invariants. Build once per freeze; parse many files with it.
 */
export function makeWorkflowFileSchema(registry: StepPluginRegistry): z.ZodType<WorkflowFile> {
  // The registry is closed over the refinement here (ADR 0044): the base schema stays registry-free.
  return buildBaseWorkflowFileSchema(makeBodySchema(registry)).superRefine((file, ctx) =>
    checkWorkflowFileInvariants(file, ctx, registry),
  ) as z.ZodType<WorkflowFile>;
}

export interface WorkflowFileParseSuccess {
  success: true;
  data: WorkflowFile;
}

export interface WorkflowFileParseFailure {
  success: false;
  errors: string[];
}

// A file carrying a superseded `format` string gets a targeted error naming the codemod, not a generic
// zod "invalid literal", because the fix is to migrate (workflow-format-v3.md §1). The check is
// symmetric (ADR 0058 §6): a version newer than `FORMAT_VERSION` gets "upgrade PATH".
export function supersededFormatError(json: unknown): WorkflowFileParseFailure | null {
  if (typeof json !== "object" || json === null) return null;
  const format = (json as { format?: unknown }).format;
  if (typeof format !== "string") return null;
  const version = formatVersionNumber(format);
  if (version !== null && version > (formatVersionNumber(FORMAT_VERSION) ?? 0)) {
    return {
      success: false,
      errors: [
        `${format} is newer than this engine reads (${FORMAT_VERSION}) — upgrade PATH to read it`,
      ],
    };
  }
  if (!(format in SUPERSEDED_FORMAT_VERSIONS)) return null;
  // Named per workflow-format-v2.md §1: the whole codemod chain in run order, since one codemod
  // migrates one step only and would not move a file that is two or three versions behind.
  const codemods = SUPERSEDED_FORMAT_VERSIONS[format as keyof typeof SUPERSEDED_FORMAT_VERSIONS];
  return {
    success: false,
    errors: [
      `${format} is no longer read — run ${codemods.join(" then ")} to migrate this file to ${FORMAT_VERSION}`,
    ],
  };
}

// `path/workflow@<n>` → n; null for anything malformed (digits only, no leading zeros).
function formatVersionNumber(format: string): number | null {
  const match = /^path\/workflow@(0|[1-9]\d*)$/.exec(format);
  return match ? Number(match[1]) : null;
}

// Parse a file against an already-built schema; `loadWorkflowTree` builds once per registry freeze and
// calls this per file in the ref tree (ADR 0018 sub-decision 7).
export function safeParseWorkflowFileWith(
  schema: z.ZodType<WorkflowFile>,
  json: unknown,
): WorkflowFileParseSuccess | WorkflowFileParseFailure {
  const superseded = supersededFormatError(json);
  if (superseded) return superseded;
  const result = schema.safeParse(json);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatIssues(result.error) };
}

// The single-file convenience door: build the open schema for `registry` and parse `json` against it.
// A caller parsing many files should build once with `makeWorkflowFileSchema` and reuse that schema.
export function safeParseWorkflowFile(
  json: unknown,
  registry: StepPluginRegistry,
): WorkflowFileParseSuccess | WorkflowFileParseFailure {
  return safeParseWorkflowFileWith(makeWorkflowFileSchema(registry), json);
}

export function parseWorkflowFile(json: unknown, registry: StepPluginRegistry): WorkflowFile {
  const result = safeParseWorkflowFile(json, registry);
  if (!result.success) {
    throw new Error(`invalid workflow file:\n${result.errors.join("\n")}`);
  }
  return result.data;
}
