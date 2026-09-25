import { z } from "zod";
import { ConfigObjectSchema } from "./config.js";
import { formatIssues } from "./format-issues.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolatedJsonValue } from "./interpolation.js";
import { makeNodeSchema, type StepPluginRegistry } from "./nodes.js";
import { nodeIdentityIssues } from "./node-identity.js";
import { gotoIssues } from "./goto.js";
import { publishSetIssues } from "./publish-set.js";
import { collectWorkerDefaultIssues } from "./worker-defaults.js";
import { STEP_ROOTS } from "./roots.js";
import { FORMAT_VERSION, SUPERSEDED_FORMAT_VERSIONS, type WorkflowFile } from "./workflow-file-type.js";
import type { WorkflowNode } from "./node-type.js";

export { FORMAT_VERSION };

// The file envelope, parameterised by its `body` schema so the plugin factory can wrap the opened
// node union `makeNodeSchema(registry)` builds. Everything except `body` is fixed grammar. There is no
// closed built-in envelope any more — a file is only ever parsed against a registry (ADR 0019, #337).
function buildBaseWorkflowFileSchema(bodySchema: z.ZodType<WorkflowNode[]>) {
  return z
    .object({
      format: z.literal(FORMAT_VERSION),
      id: IdSchema,
      name: NameSchema,
      config: ConfigObjectSchema.optional(),
      // The file's own launch seed: the JSON object a launch sends as the root input when the operator
      // supplies no override. Plain JSON — the empty root set refuses a `${…}` placeholder here, since
      // nothing interpolates the root input; it goes straight into the root context (format doc §6.3).
      // Registry-agnostic and shape-only, like `output`/`worker_defaults`.
      input: z.record(z.string(), interpolatedJsonValue([])).optional(),
      body: bodySchema,
      output: z.record(z.string(), interpolatedJsonValue(STEP_ROOTS)).optional(),
      // The file worker-default table (ADR 0044): `{ <stepType>: <workerName> }`, a per-type selection
      // for un-pinned steps. Shape only here — this schema is registry-agnostic, so "is this a real
      // type shipping that worker" is an engine-load check, not a zod constraint.
      worker_defaults: z.record(z.string().min(1), z.string().min(1)).optional(),
    })
    .strict();
}

// Every node — steps, controllers, checkpoints, and each `parallel` branch (now itself a node, `@2`
// §4.3) — carries a required human `name`, unique across the whole file at every nesting level
// (workflow-format-v2.md §3). The walk and the rule are `node-identity.ts`'s, shared with the two other
// doors that enforce an identity rule (the write route's duplicate-`id` check, the Designer's open
// gate); this refinement only turns the issues into zod issues at the offending `name` field.

// The file channel of ADR 0044's registry-relative `worker_defaults` validation (#516). The base
// schema fixes the *shape* (`{ <non-empty>: <non-empty> }`), registry-agnostically; here — with the
// registry in hand — each entry is checked for registry-relative validity through the per-entry core
// (`collectWorkerDefaultIssues`) the launch channel shares (#518), so the two channels report a bad
// selection in one voice. A bad entry is file-invalidity (discovery reports it, the Designer refuses
// the file, ADR 0026), reported against its own `worker_defaults.<type>` path so the reader sees which
// entry, not the whole table. Every bad entry is reported in one pass (aggregate). The registry is one,
// run-wide, and each file is parsed on its own, so a bad table invalidates *its* file — a child ref's,
// never its parent's.
function checkWorkerDefaults(file: WorkflowFile, ctx: z.RefinementCtx, registry: StepPluginRegistry): void {
  if (!file.worker_defaults) return;
  for (const { type, message } of collectWorkerDefaultIssues(file.worker_defaults, registry)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["worker_defaults", type], message });
  }
}

// The cross-node invariants zod's per-field parse cannot express: file-unique names, no two
// concurrent parallel branches publishing one key, no publish inside a `do-not-wait` branch, every
// goto's placement and first-level target (docs/spec/goto.md §2.3), and the
// registry-relative `worker_defaults` check (ADR 0044). Applied by the plugin factory's schema
// (`makeWorkflowFileSchema`), which closes the registry over the last argument.
function checkWorkflowFileInvariants(file: WorkflowFile, ctx: z.RefinementCtx, registry: StepPluginRegistry): void {
  // The identity rule is `node-identity.ts`'s, so this refinement and the write route cannot disagree
  // about which occurrence offends; only the reader-facing half (a zod issue at the `name` field) is
  // here. `duplicate-name` is the one rule the load enforces: `id`s are UUID-checked per field, and a
  // duplicate `id` is refused at the write door and the Designer's open gate (ADR 0015).
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
 * The whole `WorkflowFileSchema` for a given registry (ADR 0018 sub-decision 7): the file envelope
 * wrapping the open node union `makeNodeSchema(registry)` builds, plus the same cross-node invariants
 * the closed schema enforces. The registry is required and has no default — a caller with no plugins
 * still passes an empty registry, which describes a grammar with the seven control members and no leaf
 * step. Build this once per freeze and parse many files with `safeParseWorkflowFileWith`.
 */
/**
 * The **body** validator (ADR 0048 decision 7): `z.array(nodeSchema).min(1)`, and nothing else. It is
 * the one constraint a workflow file's `body` and a Step-Template's `body` share, so the two cannot
 * drift — a file body is this plus the file-scoped invariants (`makeWorkflowFileSchema`), a template
 * body is this alone (`makeStepTemplateSchema`). Registry-relative and per-node only: each element
 * validates against `makeNodeSchema(registry)` (the node union, each type's `fields`/`config`, its
 * `worker` enum), controllers are legal at the top level because a controller *is* a `WorkflowNode`,
 * and the array carries the `@2` minimum of one node. The cross-node file rules — name uniqueness, the
 * publish set, goto placement and targets, `worker_defaults` — are deliberately **not** here: they
 * are the file namespace's, not the body's, and a fragment cannot know the namespace it will land in
 * (decision 5).
 */
export function makeBodySchema(registry: StepPluginRegistry): z.ZodType<WorkflowNode[]> {
  const nodeSchema = makeNodeSchema(registry);
  return z.array(nodeSchema).min(1) as unknown as z.ZodType<WorkflowNode[]>;
}

export function makeWorkflowFileSchema(registry: StepPluginRegistry): z.ZodType<WorkflowFile> {
  // The registry is closed over the refinement here (ADR 0044 #516): the base schema stays
  // registry-free, and the whole-file check reads the registry to validate `worker_defaults` entries.
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

// A pre-migration file — or a Step-Template, which stamps the same body grammar (ADR 0048) — carrying
// a superseded `format` string gets a targeted error naming the codemod, not a generic zod "invalid
// literal": the shape changed (`@2`'s worker union, `@1`'s uniform single-node containers, `@0`'s GUID
// identity), so the fix is to migrate, not to hand-edit `format` (workflow-format-v3.md §1). Both
// `safeParseWorkflowFileWith` and `safeParseStepTemplateWith` run this pre-check. The engine reads the
// current format only — there is no dual reader.
//
// The pre-check is symmetric (ADR 0058 §6): a well-formed version *newer* than `FORMAT_VERSION` gets
// "upgrade PATH", not a bare invalid-literal, so a file written by a newer PATH is legible on an older
// engine. A malformed version string still falls through to zod's literal mismatch.
export function supersededFormatError(json: unknown): WorkflowFileParseFailure | null {
  if (typeof json !== "object" || json === null) return null;
  const format = (json as { format?: unknown }).format;
  if (typeof format !== "string") return null;
  const version = formatVersionNumber(format);
  if (version !== null && version > (formatVersionNumber(FORMAT_VERSION) ?? 0)) {
    return {
      success: false,
      errors: [`${format} is newer than this engine reads (${FORMAT_VERSION}) — upgrade PATH to read it`],
    };
  }
  if (!(format in SUPERSEDED_FORMAT_VERSIONS)) return null;
  // Per workflow-format-v2.md §1 (the ADR 0007 precedent): names the codemod script, never a generic
  // zod "invalid literal" on `format`. Each older string names its whole codemod chain in the order
  // the scripts must run, because a single codemod migrates one step only and would not move a file
  // that is two or three versions behind.
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

// The superseded-format pre-check and the success/failure shaping both doors share: parse a file
// against an already-built schema. `loadWorkflowTree` builds the schema once per registry freeze and
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
// The registry is **required** — there is no closed built-in schema to fall back on (ADR 0019, #337),
// so a caller with no plugins still passes an empty registry (a grammar of the seven control members and
// no leaf step). A caller parsing many files should build the schema once with `makeWorkflowFileSchema`
// and reuse it via `safeParseWorkflowFileWith`; this door is for the one-off case.
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
