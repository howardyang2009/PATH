import { z } from "zod";
import { interpolableString } from "./interpolation.js";
import { STEP_ROOTS } from "./roots.js";

const EngineWorkerSchema = z
  .object({
    type: z.literal("engine"),
  })
  .strict();

const LlmWorkerSchema = z
  .object({
    type: z.literal("llm"),
    model: interpolableString(STEP_ROOTS),
    options: z.record(z.unknown()).optional(),
  })
  .strict();

export const WorkerSchema = z.discriminatedUnion("type", [EngineWorkerSchema, LlmWorkerSchema]);
