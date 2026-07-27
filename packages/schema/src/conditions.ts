import { z } from "zod";
import { checkDotPath } from "./dot-path.js";
import type { AllCondition, AnyCondition, Condition, NotCondition } from "./condition-type.js";
import { CONDITION_ROOTS } from "./roots.js";

const ConditionPathSchema = z.string().superRefine((value, ctx) => {
  const result = checkDotPath(value, CONDITION_ROOTS);
  if (!result.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
  }
});

const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const RegexPatternSchema = z.string().superRefine((value, ctx) => {
  try {
    new RegExp(value);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${value}" is not a valid regular expression: ${(err as Error).message}`,
    });
  }
});

const ExistsConditionSchema = z
  .object({
    type: z.literal("exists"),
    path: ConditionPathSchema,
  })
  .strict();

const EqualsConditionSchema = z
  .object({
    type: z.literal("equals"),
    path: ConditionPathSchema,
    value: JsonScalarSchema,
  })
  .strict();

const OneOfConditionSchema = z
  .object({
    type: z.literal("one-of"),
    path: ConditionPathSchema,
    values: z.array(JsonScalarSchema).min(1),
  })
  .strict();

const MatchesConditionSchema = z
  .object({
    type: z.literal("matches"),
    path: ConditionPathSchema,
    pattern: RegexPatternSchema,
  })
  .strict();

const RangeConditionSchema = z
  .object({
    type: z.literal("range"),
    path: ConditionPathSchema,
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()
  .refine((v) => v.min !== undefined || v.max !== undefined, {
    message: "a range condition requires at least one of min/max",
  });

const ValidJsonConditionSchema = z
  .object({
    type: z.literal("valid-json"),
    path: ConditionPathSchema,
  })
  .strict();

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    ExistsConditionSchema,
    EqualsConditionSchema,
    OneOfConditionSchema,
    MatchesConditionSchema,
    RangeConditionSchema,
    ValidJsonConditionSchema,
    AllConditionSchema,
    AnyConditionSchema,
    NotConditionSchema,
  ]),
);

// ConditionSchema above is the sole recursion point (wrapped in z.lazy): by the time its lazy
// callback actually runs (at parse time), module load has already finished and these consts —
// declared after it but referencing it directly — are initialized. No further laziness needed.
const AllConditionSchema: z.ZodType<AllCondition> = z
  .object({
    type: z.literal("all"),
    of: z.array(ConditionSchema).min(1),
  })
  .strict();

const AnyConditionSchema: z.ZodType<AnyCondition> = z
  .object({
    type: z.literal("any"),
    of: z.array(ConditionSchema).min(1),
  })
  .strict();

const NotConditionSchema: z.ZodType<NotCondition> = z
  .object({
    type: z.literal("not"),
    of: ConditionSchema,
  })
  .strict();
