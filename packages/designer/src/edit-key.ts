/**
 * One field edit's identity — owner, field, and row — as a value rather than a hand-minted string: the undo fold's
 * equality and the draft hooks' reset test.
 */

/** One field edit's identity. `owner` is the node's durable GUID, or the file's own id for a file-level field. */
export interface EditKey {
  readonly owner: string;
  readonly field: string;
  readonly row?: string | number;
}

export function editKey(owner: string, field: string, row?: string | number): EditKey {
  return { owner, field, row };
}

export function sameEditKey(a: EditKey | undefined, b: EditKey | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.owner === b.owner && a.field === b.field && a.row === b.row;
}

/**
 * Commit one edit: `key` folds this commit into the in-progress undo entry when it matches the previous one; absent
 * for a structural edit.
 */
export type EditCommit<T> = (next: T, key?: EditKey) => void;
