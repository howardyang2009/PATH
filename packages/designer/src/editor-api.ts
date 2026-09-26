import { instantiate, type WorkflowFile, type WorkflowNode } from "@path/schema";
import {
  editFile,
  findById,
  isDuplicable,
  locate,
  type SingleSlot,
  unwrapEdit,
} from "./edit-tree.js";
import {
  bodyInsertSocket,
  childSocketFlavor,
  type SocketFlavor,
  socketAcceptsBody,
  socketAcceptsKind,
  socketBarred,
} from "./grammar.js";
import { cloneWithFreshIdentity, createArm, createNode, usedNames } from "./node-factory.js";
import type { Armed } from "./use-armed.js";

/**
 * The canvas's edit surface (#368): it binds the palette's **armed** value to the pure `edit-tree` ops
 * over the active file. The block tree calls these; where the grammar refuses the armed value, the tree
 * never renders a socket, so an illegal drop is unreachable rather than rejected on save (spec § Adding).
 *
 * "Placing" reads the armed value, makes the arriving node(s), applies the edit, and disarms. An armed
 * node kind mints one node (`node-factory`, a fresh client id — ADR 0015); an armed Template runs
 * Instantiation over its body (#578, ADR 0049) — fresh ids, names uniquified against the file — shaped
 * for the socket (`grammar.bodyInsertSocket`: a 2+-node body at a single node slot is wrapped in a fresh
 * `sequence`). Structural affordances that carry no kind — add-arm, add-`else`, delete,
 * reorder, duplicate — do not need an armed kind and never disarm.
 */
export interface EditorApi {
  /** What a socket says it adds — the armed node kind or the armed template's name — or `null` when unarmed. */
  armedLabel: string | null;
  /**
   * Is the socket of `flavor` owned by `ownerId` (`null` for the file body) an open drop target right now:
   * something is armed and the grammar admits it there, the owner's ancestor chain included (a goto)?
   */
  socketOpen(flavor: SocketFlavor, ownerId: string | null): boolean;
  /** Place the armed node(s) at the tail of a list socket: the file body (`null`), a `sequence`, or a `parallel`. */
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
  armed: Armed | null,
  disarm: () => void,
  defaultLeaf: string,
): EditorApi {
  const mint = (kind: string): WorkflowNode => createNode(kind, usedNames(file.body), defaultLeaf);

  /** The node(s) the armed value lands as in a socket of `flavor`. A single slot always gets exactly one. */
  const arrivals = (armed: Armed, flavor: SocketFlavor): WorkflowNode[] =>
    armed.kind === "node"
      ? [mint(armed.type)]
      : instantiate(armed.body, {
          usedNames: usedNames(file.body),
          socket: bodyInsertSocket(flavor),
        });

  /** The flavour of a list socket: the file body (`null`) is a sequence; an owner reports its own. */
  const listFlavor = (ownerId: string | null): SocketFlavor => {
    const owner = ownerId === null ? null : findById(file.body, ownerId);
    return (owner && childSocketFlavor(owner)) ?? "sequence";
  };

  return {
    armedLabel: armed === null ? null : armed.kind === "node" ? armed.type : armed.name,
    socketOpen(flavor, ownerId) {
      if (armed === null) return false;
      const barred = socketBarred(file.body, ownerId);
      return armed.kind === "node"
        ? socketAcceptsKind(flavor, armed.type, barred)
        : socketAcceptsBody(flavor, armed.body, barred);
    },
    placeIntoList(ownerId) {
      if (armed === null) return;
      const next = arrivals(armed, listFlavor(ownerId)).reduce(
        (acc, node) => unwrapEdit(editFile(acc, { kind: "add-to-list", ownerId, node })),
        file,
      );
      applyEdit(next);
      disarm();
    },
    swapSingle(target) {
      if (armed === null) return;
      const [node] = arrivals(armed, "single");
      applyEdit(unwrapEdit(editFile(file, { kind: "swap-single", target, node: node! })));
      disarm();
    },
    addArm(branchId) {
      applyEdit(
        unwrapEdit(
          editFile(file, {
            kind: "add-arm",
            branchId,
            arm: createArm(usedNames(file.body), defaultLeaf),
          }),
        ),
      );
    },
    addElse(branchId) {
      applyEdit(
        unwrapEdit(
          editFile(file, {
            kind: "add-else",
            branchId,
            node: createNode(defaultLeaf, usedNames(file.body), defaultLeaf),
          }),
        ),
      );
    },
    removeElse(branchId) {
      applyEdit(unwrapEdit(editFile(file, { kind: "remove-else", branchId })));
    },
    remove(id) {
      const result = editFile(file, { kind: "delete", id });
      if (result.ok) applyEdit(result.file);
    },
    move(id, delta) {
      const next = unwrapEdit(editFile(file, { kind: "move", id, delta }));
      if (next !== file) applyEdit(next);
    },
    duplicate(id) {
      const node = findById(file.body, id);
      if (!node) return;
      applyEdit(
        unwrapEdit(
          editFile(file, {
            kind: "insert-after",
            id,
            clone: cloneWithFreshIdentity(node, usedNames(file.body)),
          }),
        ),
      );
    },
    canRemove(id) {
      return editFile(file, { kind: "delete", id }).ok;
    },
    canMove(id) {
      const site = locate(file, id);
      return (
        site !== null &&
        (site.where === "file-body" || site.where === "list" || site.where === "arm")
      );
    },
    canDuplicate(id) {
      return isDuplicable(file, id);
    },
  };
}
