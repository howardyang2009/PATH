import { z, type ZodDiscriminatedUnionOption, type ZodRawShape } from "zod";
import { ConditionSchema } from "./conditions.js";
import { ConfigObjectSchema } from "./config.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolableString, interpolatedJsonValue } from "./interpolation.js";
import type { WorkflowNode } from "./node-type.js";
import { PUBLISH_ROOTS, STEP_ROOTS } from "./roots.js";


// The envelope fields every step node carries, shared by `buildPluginMember`. `worker` is a
// worker-*name* string, not a tagged object (`@3` §4, ADR 0021 sub-8): each step type's `worker` is a
// `z.enum` of that type's own worker names off the registry, so a step naming a worker its type does
// not ship fails at load with the valid names listed. It is optional — an omitted `worker` resolves to
// the type's default worker. There is no closed built-in union here any more: `binary`/`prompt` are two
// plugin folders discovered by the engine and handed in through the registry (ADR 0019 sub-10, #337).
export const commonStepFields = {
  id: IdSchema,
  name: NameSchema,
  config: ConfigObjectSchema.optional(),
  input: interpolatedJsonValue(STEP_ROOTS).optional(),
  parse: z.enum(["text", "json"]).optional(),
  publish: z.record(interpolatedJsonValue(PUBLISH_ROOTS)).optional(),
};

// `ref` is a relative path to another workflow file — not an interpolated position
// (workflow-format-v0.md §4.2, §5).
const RefSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), { message: "ref must be a relative path, not absolute" });

const MaxIterationsSchema = z.union([z.number().int().positive(), interpolableString(STEP_ROOTS)]);

/**
 * The recursion pair a member set closes over: the node-array slot (`sequence.body`,
 * `parallel.branches`, and the file `body`) and the single-node slot (`while-do` body, branch arm,
 * `else`). Passing it in — rather than reading a module-level `const` — is what lets the plugin
 * factory build the six control members against its *own* opened union, so a plugin step validates
 * inside those bodies too (ADR 0018 sub-decision 7).
 */
export interface NodeRecursion {
  NodeArraySchema: z.ZodType<WorkflowNode[]>;
  SingleNodeSchema: z.ZodType<WorkflowNode>;
}

/**
 * The six control-construct members — `workflow`, `parallel`, `branch`, `while-do`, `sequence`,
 * `checkpoint` — built against a given recursion pair. These are the six reserved type names: a leaf
 * step type (`prompt`, `binary`, or a plugin's) is *not* here, it arrives through the registry.
 * `workflow` sits here because its `ref` runs a nested workflow-run, not a worker (`@3` §4), so it is
 * core grammar rather than a plugin-contributed leaf.
 *
 * Returned as a plain array so both the closed module union and the plugin factory spread it into a
 * `z.discriminatedUnion` (ADR 0018 sub-decision 1); the array order does not matter to the union.
 */
export function buildCoreMembers({
  NodeArraySchema,
  SingleNodeSchema,
}: NodeRecursion): ZodDiscriminatedUnionOption<"type">[] {
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
      // `collect` waits for every branch and lands them all; `wait-one` races and keeps the first to
      // succeed, cancelling the rest (docs/spec/wait-one-join.md §2); `do-not-wait` launches every
      // branch and does not wait for any at the join (docs/spec/do-not-wait-join.md §2).
      join: z.enum(["collect", "wait-one", "do-not-wait"]),
      // Each branch *is* a node (`@2` §4.3): the `@1` `{ id, name, body }` wrapper is gone, and the
      // branch node carries its own `id` + `name` — the `collect`/`wait-one` output key.
      branches: NodeArraySchema,
    })
    .strict();

  const BranchArmSchema = z
    .object({
      when: ConditionSchema,
      // An arm's occupant is a single node (`@2` §4.3); for several nodes in order, a `sequence`.
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
      // The loop body is a single node (`@2` §4.3).
      node: SingleNodeSchema,
    })
    .strict();

  // `sequence` is the single-node grammar's answer to "this slot needs several nodes in order"
  // (`@2` §4.4). A logicer: it takes none of `worker`/`config`/`input`/`parse`/`publish`; its `body`
  // is a node array of minimum length 1, run in order, and its output is its last child's output.
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

  return [
    WorkflowStepSchema,
    ParallelNodeSchema,
    BranchNodeSchema,
    WhileDoNodeSchema,
    SequenceNodeSchema,
    CheckpointNodeSchema,
  ];
}

// ── The open node union: a pure, registry-driven factory ────────────────────────────────────────
//
// The closed union above opens to plugin-contributed leaf step types through a factory that closes
// over an injected registry (ADR 0018). `@path/schema` stays pure: it reads each entry's `fields`,
// `config`, and worker *names* only — never a `run` method, never the filesystem. The engine owns
// discovery and hands the registry in as data.

/**
 * The slice of a step-type plugin `@path/schema` reads to build a member. It is the load-bearing
 * subset of the engine's `StepPlugin` seam (ADR 0018 sub-decision 3, amended #313): the two zod
 * fragments and the worker *names*. `workers` values are `unknown` on purpose — the schema layer
 * never calls `run`, so it holds no dependency on the executor seam and stays a pure function of its
 * inputs. The engine's richer `StepPlugin` satisfies this structurally.
 */
export interface RegistryStepType {
  /** Author-fixed node fields, spread at the top level and covered by the member's `.strict()`. */
  fields: ZodRawShape;
  /** The type's config keys; composed as the `config` value's shape, passthrough (open). */
  config: ZodRawShape;
  /** The type's workers by name; only the names are read, to build the `worker` enum. */
  workers: Record<string, unknown>;
  /** The worker a step of this type uses when it names none. Carried for structural parity; the schema does not resolve it. */
  defaultWorker: string;
}

/** The injected registry: leaf step type name → its plugin slice. Keyed by the folder name (#308). */
export type StepPluginRegistry = Record<string, RegistryStepType>;

/**
 * The six reserved control-construct names. A plugin key equal to one of these is rejected before the
 * union is built, so the shadow message is PATH's own rather than zod's duplicate-value throw (which
 * stays the backstop). `prompt` / `binary` are *not* reserved here — they are leaf step types that
 * arrive through the registry, so a plugin shadowing one collides on an existing registry key instead
 * (ADR 0018 sub-decision 6, amended #313).
 */
export const RESERVED_TYPE_NAMES = [
  "workflow",
  "parallel",
  "branch",
  "while-do",
  "sequence",
  "checkpoint",
] as const;

// The envelope fields the factory composes and therefore owns: the shared `commonStepFields`, plus
// the discriminant `type` and the `worker` enum. A plugin `fields` key colliding with any of these is
// rejected loud at freeze, so the three envelope invariants stay impossible to declare wrong.
const ENVELOPE_FIELD_NAMES = new Set([...Object.keys(commonStepFields), "type", "worker"]);

/**
 * One plugin-contributed leaf member, composed so a plugin author cannot declare the envelope wrong
 * (ADR 0018 sub-decision 4): the discriminant `type` literal, the shared `commonStepFields`, the
 * plugin's `fields` at the top level under a whole-object `.strict()`, its `config` fragment as the
 * `config` value shape (passthrough, so an inherited sibling key is allowed), and `worker` as a
 * `z.enum` of this type's worker names. Throws loud at freeze on a field collision or a type that
 * ships no worker.
 */
function buildPluginMember(typeName: string, entry: RegistryStepType): ZodDiscriminatedUnionOption<"type"> {
  for (const fieldName of Object.keys(entry.fields)) {
    if (ENVELOPE_FIELD_NAMES.has(fieldName)) {
      throw new Error(
        `step type "${typeName}": field "${fieldName}" collides with an envelope field the schema owns ` +
          `(reserved: ${[...ENVELOPE_FIELD_NAMES].map((name) => `"${name}"`).join(", ")})`,
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
      // `config` is open (passthrough): a step's config also carries keys an ancestor or a sibling
      // leaf type declared, resolved at run start (ADR 0022 sub-2/sub-3). The plugin's fragment names
      // this type's own keys; the whole object stays optional, as in `commonStepFields`.
      config: z.object(entry.config).passthrough().optional(),
      // `worker` is a type-scoped name (`@3` §4): a `z.enum` of this type's worker names, optional so
      // an omitted `worker` resolves to the default at run start. An unknown name fails here with the
      // valid names listed, from zod's own enum error.
      worker: z.enum(workerNames as [string, ...string[]]).optional(),
    })
    .strict();
}

// The load error for a `type` no registry entry holds. Echoes the received value, lists every known
// type, and names the remedy — a plugin folder in the reader's own PATH tree. A workflow file
// declares no dependency block (its `type` values *are* the list), so this message is the whole of
// PATH's portability reporting (ADR 0018 sub-decision 5, amended #315). Each unknown node yields one
// such issue, so a single parse names every missing type at once, not just the first.
function describeUnknownStepType(received: unknown, known: (string | number)[]): string {
  const badType = typeof received === "string" ? `"${received}"` : received === undefined ? "(none)" : JSON.stringify(received);
  const knownList = known.length > 0 ? known.join(", ") : "(none)";
  const remedy =
    typeof received === "string"
      ? `add a step-type plugin folder packages/engine/step-plugins/${received}/ in your PATH tree`
      : "add the step-type plugin folder for it under packages/engine/step-plugins/ in your PATH tree";
  return `unknown step type ${badType} — no plugin contributes it. Known types: ${knownList}. To add it, ${remedy}`;
}

// Wraps only the discriminator miss; every other issue keeps zod's own message. `ctx.data` is the
// node object being parsed, so `ctx.data.type` is the offending value the default miss never echoes.
const unknownStepTypeErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_union_discriminator) {
    const received = (ctx.data as { type?: unknown } | undefined)?.type;
    return { message: describeUnknownStepType(received, issue.options as (string | number)[]) };
  }
  return { message: ctx.defaultError };
};

/**
 * The open node union for a given registry (ADR 0018 sub-decision 7). Reserved-name pre-check first,
 * so a shadow is PATH's own message; then the six control members and the registry's leaf members are
 * handed to one `z.discriminatedUnion`, whose recursion (`z.lazy`) closes over this same union — so a
 * plugin step validates inside `sequence` / `parallel` / `branch` / `while-do` bodies. Built once per
 * freeze; the engine parses many files against the held schema.
 */
export function makeNodeSchema(registry: StepPluginRegistry): z.ZodType<WorkflowNode> {
  for (const typeName of Object.keys(registry)) {
    if ((RESERVED_TYPE_NAMES as readonly string[]).includes(typeName)) {
      throw new Error(
        `step type "${typeName}" shadows a reserved control construct — the six control names ` +
          `(${RESERVED_TYPE_NAMES.join(", ")}) cannot be a plugin type`,
      );
    }
  }

  // `let`, not `const`: the two `z.lazy` slots below close over `NodeSchema` and read it only when the
  // union parses, by which point the assignment two statements down has run.
  let NodeSchema: z.ZodType<WorkflowNode>;
  const NodeArraySchema: z.ZodType<WorkflowNode[]> = z.lazy(() => z.array(NodeSchema).min(1));
  const SingleNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() => NodeSchema);

  const coreMembers = buildCoreMembers({ NodeArraySchema, SingleNodeSchema });
  const pluginMembers = Object.entries(registry).map(([typeName, entry]) => buildPluginMember(typeName, entry));

  NodeSchema = z.discriminatedUnion(
    "type",
    [...coreMembers, ...pluginMembers] as [ZodDiscriminatedUnionOption<"type">, ...ZodDiscriminatedUnionOption<"type">[]],
    { errorMap: unknownStepTypeErrorMap },
  ) as unknown as z.ZodType<WorkflowNode>;

  return NodeSchema;
}
