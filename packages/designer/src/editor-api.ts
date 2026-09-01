import { walkNodes, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { socketAcceptsKind, type SocketFlavor } from "./grammar.js";
import { cloneWithFreshIdentity, createArm, createNode, usedNames } from "./node-factory.js";
import {
  addArm as addArmOp,
  addElse as addElseOp,
  addToList,
  deleteNode,
  insertAfter,
  isDuplicable,
  locate,
  moveNode,
  removeElse as removeElseOp,
  swapSingleSlot,
  type SingleSlot,
} from "./edit-tree.js";

/**
 * The canvas's edit surface (#368): it binds the palette's **armed kind** to the pure `edit-tree` ops
 * over the active file. The block tree calls these; where the grammar refuses the armed kind, the tree
 * never renders a socket, so an illegal drop is unreachable rather than rejected on save (spec § Adding).
 *
 * "Placing" reads the armed kind, mints a node (`node-factory`, a fresh client id — ADR 0015), applies
 * the edit, and disarms. Structural affordances that carry no kind — add-arm, add-`else`, delete,
 * reorder, duplicate — do not need an armed kind and never disarm.
 */
export interface EditorApi {
  /** The palette kind waiting to be placed, or `null`. Drives which sockets the tree opens. */
  armedKind: string | null;
  /** Is a socket of `flavor` an open drop target right now (a kind is armed and the grammar admits it)? */
  socketOpen(flavor: SocketFlavor): boolean;
  /** Place the armed node at the tail of a list socket: the file body (`null`), a `sequence`, or a `parallel`. */
  placeIntoList(ownerId: string | null): void;
  /** Swap a single-node slot's occupant for the armed node (never emptying the slot). */
  swapSingle(target: SingleSlot): void;
  /** Add a fresh arm (default `when` + default occupant) to a `branch`. */
  addArm(branchId: string): void;
  /** Add a default-leaf `else` to a `branch` that has none (at most one `else`). */
  addElse(branchId: string): void;
  /** Remove a `branch`'s `else`. */
  removeElse(branchId: string): void;
  /** Delete a node, applying the slot rules; a refused delete is a no-op. */
  remove(id: string): void;
  /** Reorder a node one place up (`-1`) or down (`+1`) within its container. */
  move(id: string, delta: -1 | 1): void;
  /** Duplicate a list node in place, with fresh identity (a paste is a new node — ADR 0015). */
  duplicate(id: string): void;
  /** Can this node be deleted (false for the last branch / last arm)? */
  canRemove(id: string): boolean;
  /** Can this node reorder (a list element or a branch arm, not a lone single-slot occupant)? */
  canMove(id: string): boolean;
  /** Can this node be duplicated (a list element)? */
  canDuplicate(id: string): boolean;
}

/**
 * Build the edit surface over the active `file`. `applyEdit` commits a new file (marking the buffer
 * edited); `disarm` clears the palette selection after a place. `defaultLeaf` is the leaf step type a
 * block's auto-filled occupants take — the palette's first Steps entry, else `prompt`.
 */
export function createEditor(
  file: WorkflowFile,
  applyEdit: (next: WorkflowFile) => void,
  armedKind: string | null,
  disarm: () => void,
  defaultLeaf: string,
): EditorApi {
  const mint = (kind: string): WorkflowNode => createNode(kind, usedNames(file.body), defaultLeaf);

  return {
    armedKind,
    socketOpen(flavor) {
      return armedKind !== null && socketAcceptsKind(flavor, armedKind);
    },
    placeIntoList(ownerId) {
      if (armedKind === null) return;
      applyEdit(addToList(file, ownerId, mint(armedKind)));
      disarm();
    },
    swapSingle(target) {
      if (armedKind === null) return;
      applyEdit(swapSingleSlot(file, target, mint(armedKind)));
      disarm();
    },
    addArm(branchId) {
      applyEdit(addArmOp(file, branchId, createArm(usedNames(file.body), defaultLeaf)));
    },
    addElse(branchId) {
      applyEdit(addElseOp(file, branchId, createNode(defaultLeaf, usedNames(file.body), defaultLeaf)));
    },
    removeElse(branchId) {
      applyEdit(removeElseOp(file, branchId));
    },
    remove(id) {
      const result = deleteNode(file, id);
      if (result.ok) applyEdit(result.file);
    },
    move(id, delta) {
      const next = moveNode(file, id, delta);
      if (next !== file) applyEdit(next);
    },
    duplicate(id) {
      const node = [...walkNodes(file.body)].find((n) => n.id === id);
      if (!node) return;
      applyEdit(insertAfter(file, id, cloneWithFreshIdentity(node, usedNames(file.body))));
    },
    canRemove(id) {
      return deleteNode(file, id).ok;
    },
    canMove(id) {
      const site = locate(file, id);
      return site !== null && (site.where === "file-body" || site.where === "list" || site.where === "arm");
    },
    canDuplicate(id) {
      return isDuplicable(file, id);
    },
  };
}
