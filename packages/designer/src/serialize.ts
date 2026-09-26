import type { WorkflowFile } from "@path/schema";

/**
 * The canonical serialization of an open buffer: `JSON.stringify(_, null, 2)` and one trailing newline,
 * byte-identical to what the write route writes and hashes for its `ETag` (ADR 0016), so "clean" (ADR 0030) and "the
 * `If-Match` will pass" never disagree.
 */
export function canonicalSerialize(file: WorkflowFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
