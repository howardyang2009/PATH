import { z } from "zod";
import { ConditionSchema } from "./conditions.js";
import { ConfigObjectSchema } from "./config.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolableString, interpolatedJsonValue } from "./interpolation.js";
import type { WorkflowNode } from "./node-type.js";
import { PUBLISH_ROOTS, STEP_ROOTS } from "./roots.js";
import { WorkerSchema } from "./worker.js";


const commonStepFields = {
  id: IdSchema,
  name: NameSchema,
  worker: WorkerSchema.optional(),
  config: ConfigObjectSchema.optional(),
  input: interpolatedJsonValue(STEP_ROOTS).optional(),
  parse: z.enum(["text", "json"]).optional(),
  publish: z.record(interpolatedJsonValue(PUBLISH_ROOTS)).optional(),
};

const PromptStepSchema = z
  .object({
    type: z.literal("prompt"),
    ...commonStepFields,
    prompt: interpolableString(STEP_ROOTS),
  })
  .strict();

const BinaryStepSchema = z
  .object({
    type: z.literal("binary"),
    ...commonStepFields,
    command: interpolableString(STEP_ROOTS),
    args: z.array(interpolableString(STEP_ROOTS)).optional(),
    cwd: interpolableString(STEP_ROOTS).optional(),
  })
  .strict();

// `ref` is a relative path to another workflow file — not an interpolated position
// (workflow-format-v0.md §4.2, §5).
const RefSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), { message: "ref must be a relative path, not absolute" });

const WorkflowStepSchema = z
  .object({
    type: z.literal("workflow"),
    ...commonStepFields,
    ref: RefSchema,
  })
  .strict();

const MaxIterationsSchema = z.union([z.number().int().positive(), interpolableString(STEP_ROOTS)]);

// A `body` slot is an ordered node array — the workflow top level and a `sequence` (§3.1). A `node`
// slot is a single node: a `while-do` body, a branch arm, an `else`. `parallel.branches` also holds a
// node array, but its members are concurrent siblings, not an ordered sequence. All three node-array
// slots reuse `NodeArraySchema` (array, min 1); the one naming rule of `@2` (workflow-format-v2.md §3.1).
export const NodeArraySchema: z.ZodType<WorkflowNode[]> = z.lazy(() => z.array(NodeSchema).min(1));
const SingleNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() => NodeSchema);

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

export const NodeSchema: z.ZodType<WorkflowNode> = z.discriminatedUnion("type", [
  PromptStepSchema,
  BinaryStepSchema,
  WorkflowStepSchema,
  ParallelNodeSchema,
  BranchNodeSchema,
  WhileDoNodeSchema,
  SequenceNodeSchema,
  CheckpointNodeSchema,
]);
