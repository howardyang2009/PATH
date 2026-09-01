import type { WorkflowNode } from "@path/schema";

/**
 * The block grammar as the canvas enforces it (#368, designer-spec § Canvas interaction model): a
 * palette block clicks into a socket **only** where the grammar allows it, so an illegal structure is
 * *unsnappable* rather than merely rejected on save. This module is the one statement of which node
 * kind is legal in which socket, read by both the palette-into-socket add and the single-slot swap.
 *
 * At `path/workflow@2` every socket admits every step and every logicer; the one kind with a placement
 * rule is `checkpoint`. CONTEXT.md § Composition: "checkpoint sits beside the logicers, not inside
 * them" and "checkpoints can appear anywhere **in a sequence**". So a checkpoint is legal only where
 * nodes sit in an ordered list that is itself a run-in-order body — the file body and a `sequence`
 * body — and never as the sole occupant of a logicer slot (a `while-do` body, a branch arm or `else`)
 * nor as a `parallel` branch (which is inside the logicer and owes an output key a checkpoint has none
 * of). Every other kind is legal in every socket.
 */

/** A socket's shape, which fixes both its cardinality and which kinds it admits. */
export type SocketFlavor =
  /** An ordered run-in-order list: the file body or a `sequence` body. Admits every kind, checkpoint included. */
  | "sequence"
  /** A single-node slot that swaps on drop: a `while-do` body, a branch arm occupant, or `else`. No checkpoint. */
  | "single"
  /** A `parallel`'s branch list: each entry is a node owing an output key. No checkpoint. */
  | "branches";

/** The five block kinds fixed by the grammar (§ What is authorable); leaf step kinds arrive from the registry. */
export const BLOCK_KINDS = ["parallel", "branch", "while-do", "sequence", "checkpoint"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/**
 * Is `kind` legal in a socket of `flavor`? `kind` is a node `type` discriminant — a block keyword or a
 * registry leaf step type. Only `checkpoint` is restricted (to `sequence`-flavoured lists); every other
 * kind, leaf or logicer, is legal everywhere.
 */
export function socketAcceptsKind(flavor: SocketFlavor, kind: string): boolean {
  if (kind === "checkpoint") return flavor === "sequence";
  return true;
}

/** The flavour a node's own child slots expose, for a caller placing into an existing block. */
export function childSocketFlavor(node: WorkflowNode): SocketFlavor | null {
  switch (node.type) {
    case "sequence":
      return "sequence";
    case "parallel":
      return "branches";
    case "while-do":
      return "single";
    case "branch":
      return "single"; // both an arm occupant and `else` are single slots
    default:
      return null; // leaves and `checkpoint` and `workflow` nest nothing inline
  }
}
