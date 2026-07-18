import { z } from "zod";
import { ConditionSchema } from "./conditions.js";
import { ConfigObjectSchema } from "./config.js";
import { IdSchema } from "./ids.js";
import { interpolableString, interpolatedJsonValue } from "./interpolation.js";
import type { WorkflowNode } from "./node-type.js";
import { WorkerSchema } from "./worker.js";

const STEP_ROOTS = ["config", "context"] as const;
const PUBLISH_ROOTS = ["config", "context", "output"] as const;

const commonStepFields = {
  id: IdSchema,
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

export const NodeArraySchema: z.ZodType<WorkflowNode[]> = z.lazy(() => z.array(NodeSchema).min(1));

const ParallelBranchSchema = z
  .object({
    id: IdSchema,
    body: NodeArraySchema,
  })
  .strict();

const ParallelNodeSchema = z
  .object({
    type: z.literal("parallel"),
    id: IdSchema,
    join: z.literal("collect"),
    branches: z.array(ParallelBranchSchema).min(1),
  })
  .strict();

const BranchArmSchema = z
  .object({
    when: ConditionSchema,
    body: NodeArraySchema,
  })
  .strict();

const BranchNodeSchema = z
  .object({
    type: z.literal("branch"),
    id: IdSchema,
    arms: z.array(BranchArmSchema).min(1),
    else: NodeArraySchema.optional(),
  })
  .strict();

const WhileDoNodeSchema = z
  .object({
    type: z.literal("while-do"),
    id: IdSchema,
    condition: ConditionSchema,
    max_iterations: MaxIterationsSchema,
    body: NodeArraySchema,
  })
  .strict();

const CheckpointNodeSchema = z
  .object({
    type: z.literal("checkpoint"),
    id: IdSchema,
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
  CheckpointNodeSchema,
]);
