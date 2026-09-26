import { z } from "zod";

// docs/format/workflow-format.md §3: one pattern for the workflow's and every node's human `name`, unique file-wide.
export const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const NameSchema = z.string().regex(NAME_PATTERN, "name must match ^[a-z][a-z0-9-]*$");

// The durable `id` (ADR 0006): a UUIDv4 assigned once, never regenerated — the reuse/resume key and log `node_id`.
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const IdSchema = z.string().regex(UUID_V4_PATTERN, "id must be a UUIDv4");
