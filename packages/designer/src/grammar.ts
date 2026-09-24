import type { WorkflowNode } from "@path/schema";

/**
 * The block grammar as the canvas enforces it (#368, designer-spec § Canvas interaction model): a
 * palette block clicks into a socket **only** where the grammar allows it, so an illegal structure is
 * *unsnappable* rather than merely rejected on save. This module is the one statement of which node
 * kind is legal in which socket, read by both the palette-into-socket add and the single-slot swap.
 *
 * At `path/workflow@2` every socket admits every step and every controller; the one kind with a placement
 * rule is `checkpoint`. Per CONTEXT.md § Composition it is a controller but not a block type, and a
 * checkpoint "can appear anywhere **in a sequence**". So a checkpoint is legal only where
 * nodes sit in an ordered list that is itself a run-in-order body — the file body and a `sequence`
 * body — and never as the sole occupant of a controller slot (a `while-do` body, a branch arm or `else`)
 * nor as a `parallel` branch (which is inside the controller and owes an output key a checkpoint has none
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

/** The five controller kinds fixed by the grammar (§ What is authorable); leaf step kinds arrive from the registry. */
export const CONTROLLER_KINDS = ["parallel", "branch", "while-do", "sequence", "checkpoint"] as const;
export type ControllerKind = (typeof CONTROLLER_KINDS)[number];

/**
 * Is `kind` legal in a socket of `flavor`? `kind` is a node `type` discriminant — a block keyword or a
 * registry leaf step type. Only `checkpoint` is restricted (to `sequence`-flavoured lists); every other
 * kind, leaf or controller, is legal everywhere.
 */
export function socketAcceptsKind(flavor: SocketFlavor, kind: string): boolean {
  if (kind === "checkpoint") return flavor === "sequence";
  return true;
}

/**
 * How a Step-Template body lands in a socket of `flavor` (#578, ADR 0049 decision 6), as the
 * `instantiate` socket option. A `sequence`-flavoured list splices the nodes in directly. A single slot
 * and a `parallel` branch each take one node, so a 2+-node body is wrapped in a fresh `sequence` there:
 * a template body is an ordered run, and splicing it as several branches would run it concurrently.
 */
export function bodyInsertSocket(flavor: SocketFlavor): "list" | "single" {
  return flavor === "sequence" ? "list" : "single";
}

/**
 * Is a Step-Template `body` legal in a socket of `flavor`? The same rule as {@link socketAcceptsKind},
 * applied to what actually lands: every node when the list splices them, the lone node when a one-node
 * body inserts bare, and a fresh `sequence` (legal everywhere) when a 2+-node body is wrapped. An empty
 * body places nothing, so it opens no socket.
 */
export function socketAcceptsBody(flavor: SocketFlavor, body: readonly WorkflowNode[]): boolean {
  if (body.length === 0) return false;
  if (bodyInsertSocket(flavor) === "list") return body.every((node) => socketAcceptsKind(flavor, node.type));
  return body.length >= 2 || socketAcceptsKind(flavor, body[0]!.type);
}

/**
 * Does a node of `type` carry the step envelope (`config` / `input` / `parse` / `publish`)? Every leaf
 * step type and `workflow` does; the five controllers (`CONTROLLER_KINDS`) do not — they are engine
 * constructs with no worker and no task (CONTEXT.md § Composition). So the predicate is exactly "not a
 * controller kind", which is why it lives beside `CONTROLLER_KINDS` rather than repeating that set.
 */
export function carriesEnvelope(type: string): boolean {
  return !(CONTROLLER_KINDS as readonly string[]).includes(type);
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
