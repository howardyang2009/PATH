import { z } from "zod";

// workflow-format-v0.md §2/§3: the human `name` on the workflow and every node/branch shares one
// pattern. `name` is the readable identity — it keys `collect`/`wait-one` output, the log narrates
// it, and it stays unique across the whole file.
export const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const NameSchema = z.string().regex(NAME_PATTERN, "name must match ^[a-z][a-z0-9-]*$");

// The durable machine identity `id` carried by the workflow and every node/branch (ADR 0006): a
// UUIDv4, assigned once by the codemod and never regenerated — it is the reuse/resume key and the
// `node_id` a run row and log event carry. Required; a missing `id` is a load error, not an
// auto-stamp. Validated in the canonical 8-4-4-4-12 hex shape with a `4` version nibble.
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const IdSchema = z.string().regex(UUID_V4_PATTERN, "id must be a UUIDv4");
