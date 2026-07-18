import { z } from "zod";
import { interpolableString } from "./interpolation.js";

const EngineWorkerSchema = z
  .object({
    type: z.literal("engine"),
  })
  .strict();

const LlmWorkerSchema = z
  .object({
    type: z.literal("llm"),
    model: interpolableString(["config", "context"]),
    options: z.record(z.unknown()).optional(),
  })
  .strict();

export const WorkerSchema = z.discriminatedUnion("type", [EngineWorkerSchema, LlmWorkerSchema]);
