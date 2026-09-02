import type { WorkflowFile } from "@path/schema";

/**
 * The canonical serialization of an open buffer — the single serializer the save-point content-equality
 * of [ADR 0030](../../../docs/adr/0030-clean-is-content-equality-to-the-save-point-baseline.md) is
 * measured with. It is byte-identical to what the write route writes and hashes for its `ETag`
 * (`packages/server/src/routes/put-workflow.ts`, ADR 0016): `JSON.stringify(_, null, 2)` with a single
 * trailing newline, every key in the order the buffer object carries it (author/parse order preserved),
 * and every `id` kept (ADR 0015).
 *
 * "Clean" is `canonicalSerialize(buffer) === baseline`; because this is the same byte source the ETag
 * hashes, "clean" and "the `If-Match` precondition will pass" never disagree. This is the one load-bearing
 * cost ADR 0030 names: the serializer must not drift from the write route's.
 */
export function canonicalSerialize(file: WorkflowFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
