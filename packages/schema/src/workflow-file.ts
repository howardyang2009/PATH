import { z } from "zod";
import { ConfigObjectSchema } from "./config.js";
import { formatIssues } from "./format-issues.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolatedJsonValue } from "./interpolation.js";
import { childBodies } from "./node-walk.js";
import { describeUnknownStepType, describeUnknownWorker, makeNodeSchema, type StepPluginRegistry } from "./nodes.js";
import { publishSetIssues } from "./publish-set.js";
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
      body: bodySchema,
      output: z.record(z.string(), interpolatedJsonValue(STEP_ROOTS)).optional(),
      // The file worker-default table (ADR 0044): `{ <stepType>: <workerName> }`, a per-type selection
      // for un-pinned steps. Shape only here — this schema is registry-agnostic, so "is this a real
      // type shipping that worker" is an engine-load check, not a zod constraint.
      worker_defaults: z.record(z.string().min(1), z.string().min(1)).optional(),
    })
    .strict();
}

interface NameOccurrence {
  name: string;
  path: (string | number)[];
}

// Every node — steps, controllers, checkpoints, and each `parallel` branch (now itself a node, `@2`
// §4.3) — carries a required human `name`, unique across the whole file at every nesting level
// (workflow-format-v2.md §3). The GUID `id` beside it is unique by construction, so only `name` is
// checked here. Branch nodes are reached by ordinary recursion: `childBodies` exposes each branch as
// a one-node slot, so its `name` is collected like any other node's.
function collectNames(nodes: WorkflowNode[], basePath: (string | number)[]): NameOccurrence[] {
  const found: NameOccurrence[] = [];

  nodes.forEach((node, index) => {
    const nodePath = [...basePath, index];
    found.push({ name: node.name, path: [...nodePath, "name"] });

    for (const child of childBodies(node)) {
      found.push(...collectNames(child.nodes, [...nodePath, ...child.path]));
    }
  });

  return found;
}

// The file channel of ADR 0044's registry-relative `worker_defaults` validation (#516). The base
// schema fixes the *shape* (`{ <non-empty>: <non-empty> }`), registry-agnostically; here — with the
// registry in hand — each entry is checked for registry-relative validity: the key names an installed
// step type, and the value names a worker that type ships. A bad entry is file-invalidity (discovery
// reports it, the Designer refuses the file, ADR 0026), reported against its own `worker_defaults.<type>`
// path so the reader sees which entry, not the whole table. Every bad entry is reported in one pass
// (aggregate), and the two failure classes reuse the node channels' wording: an absent type echoes the
// type + the installed list + the remedy (`describeUnknownStepType`), an absent worker lists the type's
// shipped names (`describeUnknownWorker`). The registry is one, run-wide, and each file is parsed on its
// own, so a bad table invalidates *its* file — a child ref's, never its parent's.
function checkWorkerDefaults(file: WorkflowFile, ctx: z.RefinementCtx, registry: StepPluginRegistry): void {
  if (!file.worker_defaults) return;
  for (const [type, workerName] of Object.entries(file.worker_defaults)) {
    const entry = registry[type];
    if (!entry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["worker_defaults", type],
        message: describeUnknownStepType(type, Object.keys(registry)),
      });
      continue;
    }
    const workerNames = Object.keys(entry.workers);
    if (!workerNames.includes(workerName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["worker_defaults", type],
        message: describeUnknownWorker(type, workerNames, workerName),
      });
    }
  }
}

// The cross-node invariants zod's per-field parse cannot express: file-unique names, no two
// concurrent parallel branches publishing one key, no publish inside a `do-not-wait` branch, and the
// registry-relative `worker_defaults` check (ADR 0044). Applied by the plugin factory's schema
// (`makeWorkflowFileSchema`), which closes the registry over the last argument.
function checkWorkflowFileInvariants(file: WorkflowFile, ctx: z.RefinementCtx, registry: StepPluginRegistry): void {
  const occurrences = collectNames(file.body, ["body"]);
  const byName = new Map<string, NameOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = byName.get(occurrence.name) ?? [];
    list.push(occurrence);
    byName.set(occurrence.name, list);
  }

  for (const [name, list] of byName) {
    if (list.length <= 1) continue;
    for (const occurrence of list.slice(1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: occurrence.path,
        message: `duplicate name "${name}": names must be unique across the whole file`,
      });
    }
  }

  for (const issue of publishSetIssues(file)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }

  checkWorkerDefaults(file, ctx, registry);
}

/**
 * The whole `WorkflowFileSchema` for a given registry (ADR 0018 sub-decision 7): the file envelope
 * wrapping the open node union `makeNodeSchema(registry)` builds, plus the same cross-node invariants
 * the closed schema enforces. The registry is required and has no default — a caller with no plugins
 * still passes an empty registry, which describes a grammar with the six control members and no leaf
 * step. Build this once per freeze and parse many files with `safeParseWorkflowFileWith`.
 */
export function makeWorkflowFileSchema(registry: StepPluginRegistry): z.ZodType<WorkflowFile> {
  const nodeSchema = makeNodeSchema(registry);
  const bodySchema = z.array(nodeSchema).min(1) as unknown as z.ZodType<WorkflowNode[]>;
  // The registry is closed over the refinement here (ADR 0044 #516): the base schema stays
  // registry-free, and the whole-file check reads the registry to validate `worker_defaults` entries.
  return buildBaseWorkflowFileSchema(bodySchema).superRefine((file, ctx) =>
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

// A pre-migration file carrying a superseded `format` string gets a targeted error naming the
// codemod, not a generic zod "invalid literal": the shape changed (`@2`'s worker union, `@1`'s
// uniform single-node containers, `@0`'s GUID identity), so the fix is to migrate, not to hand-edit
// `format` (workflow-format-v3.md §1). The engine reads `@3` only — there is no dual reader.
function supersededFormatError(json: unknown): WorkflowFileParseFailure | null {
  if (typeof json !== "object" || json === null) return null;
  const format = (json as { format?: unknown }).format;
  if (typeof format !== "string" || !(format in SUPERSEDED_FORMAT_VERSIONS)) return null;
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
// so a caller with no plugins still passes an empty registry (a grammar of the six control members and
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
