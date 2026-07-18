import { z } from "zod";

// workflow-format-v0.md §2/§3: node ids and the workflow name share one pattern.
export const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const IdSchema = z.string().regex(NAME_PATTERN, "id must match ^[a-z][a-z0-9-]*$");
export const NameSchema = z.string().regex(NAME_PATTERN, "name must match ^[a-z][a-z0-9-]*$");
