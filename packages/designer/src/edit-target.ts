import type { WorkflowFile, WorkflowNode } from "@path/schema";
import { editFile, unwrapEdit } from "./edit-tree.js";

/**
 * The pane's one write door into the buffer: a node edit spliced in place, plus the optional-key policy — an empty
 * field means *no key*, never `{}` or `""`.
 */

export function withoutKey<T extends object>(value: T, key: string): T {
  const { [key]: _dropped, ...rest } = value as Record<string, unknown>;
  return rest as T;
}

/** Set a key, or **omit it** when `next` is `undefined` — the optional-key policy the pane's regions share. */
export function withOptionalKey<T extends object>(value: T, key: string, next: unknown): T {
  return next === undefined ? withoutKey(value, key) : ({ ...value, [key]: next } as T);
}

/** Commit a node edit in place in its body; `at` is the id the body holds **now** — the previous id for a
 * re-key. An unknown id is `editFile`'s no-op, so a stale commit is nothing to write rather than a crash. */
export function replaceNode(
  file: WorkflowFile,
  node: WorkflowNode,
  at: string = node.id,
): WorkflowFile {
  return unwrapEdit(editFile(file, { kind: "replace", id: at, node }));
}
