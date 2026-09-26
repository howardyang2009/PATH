import type { WorkflowFile, WorkflowNode } from "@path/schema";
import { editFile, unwrapEdit } from "./edit-tree.js";

/**
 * The pane's one write door into the **Buffer** (#369/#370): how a file-level or node-level edit lands.
 *
 * **What this module exists to own.** The pane wrote two idioms for one buffer. A node field went
 * node → `editFile(replace)` → `unwrapEdit` → `applyEdit`, re-spelled at each node-editing site; a
 * file field went straight to `applyEdit` with a hand-built `{ ...file, key }` and an `as WorkflowFile`
 * cast, and every region whose field could empty destructured the key away itself. "An author edits one
 * buffer" is one fact, so it has one module:
 *
 * - {@link replaceNode} — a node edit, spliced in place in its body;
 * - {@link withOptionalKey} — a key that an empty field must **omit** rather than write empty;
 * - {@link withoutKey} — the omission itself, the one "no `{}` and no `{}`-shaped noise" step the node
 *   helpers, the config helpers and the file regions share.
 */

/** Omit one key, as a copy. An empty field means *no key*, never `{}` or `""` (the pane's own policy). */
export function withoutKey<T extends object>(value: T, key: string): T {
  const { [key]: _dropped, ...rest } = value as Record<string, unknown>;
  return rest as T;
}

/** Set a key, or **omit it** when `next` is `undefined` — the optional-key policy the pane's regions share. */
export function withOptionalKey<T extends object>(value: T, key: string, next: unknown): T {
  return next === undefined ? withoutKey(value, key) : ({ ...value, [key]: next } as T);
}

/**
 * Commit a node edit in place in its body — the one node splice the pane's field commits and the
 * `workflow`-ref authoring flow both use. `at` is the id the body holds **now**: the node's own id for
 * every field edit, and the *previous* id for a re-key (ADR 0015) — the one edit that changes the id it
 * is found by. An id the body does not hold is `editFile`'s documented no-op: the same file comes back,
 * so a stale commit is nothing to write rather than a crash.
 */
export function replaceNode(
  file: WorkflowFile,
  node: WorkflowNode,
  at: string = node.id,
): WorkflowFile {
  return unwrapEdit(editFile(file, { kind: "replace", id: at, node }));
}
