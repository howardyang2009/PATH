/**
 * One field edit's **identity** — which owner, which field, and which row of a keyed field — as a
 * value rather than a hand-minted string.
 *
 * Two readers need the same answer, and each used to get it as its own convention:
 *
 * - the **undo fold** (`session-reducer.ts`) folds consecutive commits whose identity is equal into
 *   one entry, so a run of keystrokes in one field is one undo (#389); and
 * - the **draft hooks** (`validated-draft.ts`) re-seed their draft when the identity changes, so a
 *   field never shows the previously selected node's text.
 *
 * The pane spelled `"name:" + node.id` and its thirteen siblings at fourteen call sites, and passed a
 * second, independent string as a React `key` to make the drafts re-seed. A colliding string folded
 * two fields into one undo entry; a forgotten `key` showed the wrong draft; nothing tied the two
 * together. Here one value states which edit this is, `sameEditKey` is the fold's equality, and the
 * hooks take the identity directly instead of depending on a `key` their caller had to remember.
 */

/**
 * The identity of one field edit. `owner` is the durable GUID of the node the field belongs to, or
 * the file's own id for a file-level field (the file's `output` map, its `config`) — an id, not a
 * constant, because switching frames must change the identity and so re-seed the field's draft.
 */
export interface EditKey {
  readonly owner: string;
  /** The node field or file region the edit touches, e.g. `name`, `command`, `config`, `publish`. */
  readonly field: string;
  /** Which row of a keyed field (a config key, a publish index), when the field has rows. */
  readonly row?: string | number;
}

/** Build one field edit's identity. */
export function editKey(owner: string, field: string, row?: string | number): EditKey {
  return { owner, field, row };
}

/** Whether two identities name the same edit — the undo fold's equality, and the draft hooks' reset test. */
export function sameEditKey(a: EditKey | undefined, b: EditKey | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.owner === b.owner && a.field === b.field && a.row === b.row;
}

/**
 * Commit one edit to the active buffer: `key` folds this commit into the in-progress entry when it
 * matches the previous one, and is absent for a structural edit (each its own entry, #389).
 */
export type EditCommit<T> = (next: T, key?: EditKey) => void;
