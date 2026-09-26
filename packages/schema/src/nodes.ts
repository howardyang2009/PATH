import { type ZodRawShape, z } from "zod";
import { ConditionSchema } from "./conditions.js";
import { ConfigObjectSchema } from "./config.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolableString, interpolatedJsonValue } from "./interpolation.js";
import type { WorkflowNode } from "./node-type.js";
import { PUBLISH_ROOTS, STEP_ROOTS } from "./roots.js";

// The envelope fields every step node carries, shared by `buildPluginMember`. `worker` is a worker-*name*
// string, not a tagged object: each step type's `worker` is a `z.enum` of its own registry worker names,
// optional so an omitted one resolves to the type's default.
export const commonStepFields = {
  id: IdSchema,
  name: NameSchema,
  config: ConfigObjectSchema.optional(),
  input: interpolatedJsonValue(STEP_ROOTS).optional(),
  parse: z.enum(["text", "json"]).optional(),
  publish: z.record(z.string(), interpolatedJsonValue(PUBLISH_ROOTS)).optional(),
};

// `ref` is a relative path to another workflow file — not an interpolated position (docs/format/workflow-format.md §4).
const RefSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), {
    message: "ref must be a relative path, not absolute",
  });

const MaxIterationsSchema = z.union([z.number().int().positive(), interpolableString(STEP_ROOTS)]);

/**
 * The recursion pair a member set closes over: the node-array slot and the single-node slot, injected so the plugin
 * factory builds the control members against its own opened union (ADR 0018).
 */
export interface NodeRecursion {
  NodeArraySchema: z.ZodType<WorkflowNode[]>;
  SingleNodeSchema: z.ZodType<WorkflowNode>;
}

/**
 * The seven control-construct members — `workflow`, `parallel`, `branch`, `while-do`, `sequence`, `checkpoint`,
 * `goto` — built against a given recursion pair; `workflow` sits here because its `ref` runs a nested workflow-run,
 * not a worker. Returned as a plain array for a `z.discriminatedUnion` (ADR 0018).
 */
export function buildCoreMembers({
  NodeArraySchema,
  SingleNodeSchema,
}: NodeRecursion): z.ZodObject[] {
  const WorkflowStepSchema = z
    .object({
      type: z.literal("workflow"),
      ...commonStepFields,
      ref: RefSchema,
    })
    .strict();

  const ParallelNodeSchema = z
    .object({
      type: z.literal("parallel"),
      id: IdSchema,
      name: NameSchema,
      // `collect` waits for every branch and lands them all; `wait-one` races and keeps the first success,
      // cancelling the rest (wait-one-join.md §2); `do-not-wait` launches and waits for none (§2).
      join: z.enum(["collect", "wait-one", "do-not-wait"]),
      // Each branch *is* a node carrying its own `id` + `name` — the `collect`/`wait-one` output key.
      branches: NodeArraySchema,
    })
    .strict();

  const BranchArmSchema = z
    .object({
      when: ConditionSchema,
      // An arm's occupant is a single node; for several nodes in order, a `sequence`.
      node: SingleNodeSchema,
    })
    .strict();

  const BranchNodeSchema = z
    .object({
      type: z.literal("branch"),
      id: IdSchema,
      name: NameSchema,
      arms: z.array(BranchArmSchema).min(1),
      else: SingleNodeSchema.optional(),
    })
    .strict();

  const WhileDoNodeSchema = z
    .object({
      type: z.literal("while-do"),
      id: IdSchema,
      name: NameSchema,
      condition: ConditionSchema,
      max_iterations: MaxIterationsSchema,
      node: SingleNodeSchema,
    })
    .strict();

  // `sequence` is the single-node grammar's answer to "this slot needs several nodes in order": a controller
  // whose `body` runs in order, and whose output is its last child's.
  const SequenceNodeSchema = z
    .object({
      type: z.literal("sequence"),
      id: IdSchema,
      name: NameSchema,
      body: NodeArraySchema,
    })
    .strict();

  const CheckpointNodeSchema = z
    .object({
      type: z.literal("checkpoint"),
      id: IdSchema,
      name: NameSchema,
      condition: ConditionSchema,
    })
    .strict();

  // `goto` is the one Graph Controller (ADR 0057): no child body and no step envelope. `target` is the
  // target's *name*, never its id (ADR 0056); `max_jumps` has no default, and file-scoped rules live in `goto.ts`.
  const GotoNodeSchema = z
    .object({
      type: z.literal("goto"),
      id: IdSchema,
      name: NameSchema,
      target: NameSchema,
      max_jumps: MaxIterationsSchema,
    })
    .strict();

  return [
    WorkflowStepSchema,
    ParallelNodeSchema,
    BranchNodeSchema,
    WhileDoNodeSchema,
    SequenceNodeSchema,
    CheckpointNodeSchema,
    GotoNodeSchema,
  ];
}

// ── The open node union: a pure, registry-driven factory; the engine owns discovery ────────────────

/**
 *
 * The slice of a step-type plugin `@path/schema` reads: the two zod fragments and the worker names. `workers` values
 * are `unknown` on purpose — the schema never calls `run`, so it stays pure.
 *
 */
export interface RegistryStepType {
  fields: ZodRawShape;
  config: ZodRawShape;
  workers: Record<string, unknown>;
  defaultWorker: string;
}

/** The injected registry: leaf step type name → its plugin slice, keyed by the folder name. */
export type StepPluginRegistry = Record<string, RegistryStepType>;

/**
 * The seven reserved control-construct names; a plugin key equal to one is rejected before the union is built, so
 * the shadow message is PATH's own. `prompt`/`binary` are leaf types arriving through the registry (ADR 0018).
 */
export const RESERVED_TYPE_NAMES = [
  "workflow",
  "parallel",
  "branch",
  "while-do",
  "sequence",
  "checkpoint",
  "goto",
] as const;

/**
 * The identity/control envelope keys a step node carries: `commonStepFields` plus `type` and `worker`. Derived from
 * `commonStepFields`, so a new envelope field lands here; the plugin factory rejects a `fields` key colliding with
 * it.
 */
export const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(commonStepFields),
  "type",
  "worker",
]);

/**
 * One plugin-contributed leaf member, composed so a plugin author cannot declare the envelope wrong (ADR 0018): the
 * `type` literal, the shared envelope, the plugin's `fields` under `.strict()`, its `config` fragment, and a `worker`
 * enum. Throws at freeze on a collision or no worker.
 */
function buildPluginMember(typeName: string, entry: RegistryStepType): z.ZodObject {
  for (const fieldName of Object.keys(entry.fields)) {
    if (ENVELOPE_KEYS.has(fieldName)) {
      throw new Error(
        `step type "${typeName}": field "${fieldName}" collides with an envelope field the schema owns ` +
          `(reserved: ${[...ENVELOPE_KEYS].map((name) => `"${name}"`).join(", ")})`,
      );
    }
  }

  const workerNames = Object.keys(entry.workers);
  if (workerNames.length === 0) {
    throw new Error(`step type "${typeName}": a leaf step type must ship at least one worker`);
  }

  return z
    .object({
      ...commonStepFields,
      ...entry.fields,
      type: z.literal(typeName),
      // `config` is open (passthrough): a step's config also carries keys an ancestor or a sibling leaf type
      // declared, resolved at run start (ADR 0022). The plugin's fragment names this type's own keys.
      config: z.object(entry.config).passthrough().optional(),
      // `worker` is a type-scoped name: an optional enum of this type's worker names, so an omitted one
      // resolves to the default at run start. zod v4 drops the received value, so the custom error restores it.
      worker: z
        .enum(workerNames as [string, ...string[]], {
          error: (issue) =>
            describeUnknownWorker(typeName, workerNames, (issue as { input?: unknown }).input),
        })
        .optional(),
    })
    .strict();
}

// The load error for a `worker` a step type does not ship: echoes the offending value and lists the shipped
// names. Shared by the node `worker` enum and the file `worker_defaults` check, so both report one wording.
export function describeUnknownWorker(
  typeName: string,
  workerNames: string[],
  received: unknown,
): string {
  return `unknown worker "${String(received)}" — "${typeName}" ships ${workerNames.map((w) => `"${w}"`).join(" | ")}`;
}

// The load error for a `type` no registry entry holds: echoes the received value, lists every known type, and
// names the remedy. Each unknown node yields one issue, so a single parse names every missing type at once.
export function describeUnknownStepType(received: unknown, known: (string | number)[]): string {
  const badType =
    typeof received === "string"
      ? `"${received}"`
      : received === undefined
        ? "(none)"
        : JSON.stringify(received);
  const knownList = known.length > 0 ? known.join(", ") : "(none)";
  const remedy =
    typeof received === "string"
      ? `add a step-type plugin folder packages/engine/plugin/step-plugin/${received}/ in your PATH tree`
      : "add the step-type plugin folder for it under packages/engine/plugin/step-plugin/ in your PATH tree";
  return `unknown step type ${badType} — no plugin contributes it. Known types: ${knownList}. To add it, ${remedy}`;
}

// Wraps only the discriminator miss; every other issue keeps zod's own message. zod v4 folds that miss into
// `invalid_union` and carries the parsed value on `issue.input`, which the default message never echoes.
const unknownStepTypeErrorMap: z.ZodErrorMap = (issue) => {
  if (issue.code === "invalid_union") {
    const received = (issue.input as { type?: unknown } | undefined)?.type;
    const options = (issue as { options?: (string | number)[] }).options ?? [];
    return { message: describeUnknownStepType(received, options) };
  }
  return undefined;
};

/**
 * The open node union for a registry (ADR 0018): reserved-name pre-check first, then the control members and the
 * registry's leaf members in one `z.discriminatedUnion` whose `z.lazy` recursion closes over this union. Built once
 * per freeze.
 */
export function makeNodeSchema(registry: StepPluginRegistry): z.ZodType<WorkflowNode> {
  for (const typeName of Object.keys(registry)) {
    if ((RESERVED_TYPE_NAMES as readonly string[]).includes(typeName)) {
      throw new Error(
        `step type "${typeName}" shadows a reserved control construct — the seven control names ` +
          `(${RESERVED_TYPE_NAMES.join(", ")}) cannot be a plugin type`,
      );
    }
  }

  // `let`, not `const`: the two `z.lazy` slots below close over `NodeSchema` and read it only when the union parses.
  let NodeSchema: z.ZodType<WorkflowNode>;
  const NodeArraySchema: z.ZodType<WorkflowNode[]> = z.lazy(() => z.array(NodeSchema).min(1));
  const SingleNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() => NodeSchema);

  const coreMembers = buildCoreMembers({ NodeArraySchema, SingleNodeSchema });
  const pluginMembers = Object.entries(registry).map(([typeName, entry]) =>
    buildPluginMember(typeName, entry),
  );

  NodeSchema = z.discriminatedUnion(
    "type",
    [...coreMembers, ...pluginMembers] as unknown as readonly [z.ZodObject, ...z.ZodObject[]],
    { error: unknownStepTypeErrorMap },
  ) as unknown as z.ZodType<WorkflowNode>;

  return NodeSchema;
}
