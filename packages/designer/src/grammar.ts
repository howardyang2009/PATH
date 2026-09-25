import { childBodies, walkNodes, type WorkflowNode } from "@path/schema";

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
 *
 * At `path/workflow@5` a `goto` (#619, designer-spec § goto) adds the one rule no flavor can state: it may
 * not sit under a `while-do` or a `parallel` at **any** depth. So a socket is also **barred** or not, read
 * off its ancestor chain (`socketBarred`), and every predicate here takes that bit beside the flavor.
 */

/** A socket's shape, which fixes both its cardinality and which kinds it admits. */
export type SocketFlavor =
  /** An ordered run-in-order list: the file body or a `sequence` body. Admits every kind, checkpoint included. */
  | "sequence"
  /** A single-node slot that swaps on drop: a `while-do` body, a branch arm occupant, or `else`. No checkpoint. */
  | "single"
  /** A `parallel`'s branch list: each entry is a node owing an output key. No checkpoint. */
  | "branches";

/** The six controller kinds fixed by the grammar, five Structure Controllers and the one Graph Controller (`goto`, ADR 0057) (§ What is authorable); leaf step kinds arrive from the registry. */
export const CONTROLLER_KINDS = ["parallel", "branch", "while-do", "sequence", "checkpoint", "goto"] as const;
export type ControllerKind = (typeof CONTROLLER_KINDS)[number];

/**
 * Is `kind` legal in a socket of `flavor`, `barred` or not? `kind` is a node `type` discriminant — a block
 * keyword or a registry leaf step type. `checkpoint` is restricted to `sequence`-flavoured lists and
 * `goto` to unbarred sockets; every other kind, leaf or controller, is legal everywhere.
 */
export function socketAcceptsKind(flavor: SocketFlavor, kind: string, barred = false): boolean {
  if (kind === "checkpoint") return flavor === "sequence";
  if (kind === "goto") return !barred;
  return true;
}

/**
 * Does the socket owned by `ownerId` (`null` for the file body) sit under a `while-do` or a `parallel`?
 * The owner itself counts: a `while-do` body slot and a `parallel` branch list sit under it.
 * This is the ancestor chain the goto placement rule reads (`@path/schema` `gotoIssues`, `placement`).
 */
export function socketBarred(body: readonly WorkflowNode[], ownerId: string | null): boolean {
  if (ownerId === null) return false;
  const visit = (nodes: readonly WorkflowNode[], barred: boolean): boolean | null => {
    for (const node of nodes) {
      const inner = barred || node.type === "while-do" || node.type === "parallel";
      if (node.id === ownerId) return inner;
      for (const child of childBodies(node)) {
        const found = visit(child.nodes, inner);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(body, false) ?? false;
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
 * applied to what actually lands (and, at a `barred` socket, refusing a goto anywhere in the body): every node when the list splices them, the lone node when a one-node
 * body inserts bare, and a fresh `sequence` (legal everywhere) when a 2+-node body is wrapped. An empty
 * body places nothing, so it opens no socket.
 */
export function socketAcceptsBody(flavor: SocketFlavor, body: readonly WorkflowNode[], barred = false): boolean {
  if (body.length === 0) return false;
  // A goto at any depth of the body lands under the socket's barrier, wrapped or spliced alike.
  if (barred && [...walkNodes([...body])].some((node) => node.type === "goto")) return false;
  if (bodyInsertSocket(flavor) === "list") return body.every((node) => socketAcceptsKind(flavor, node.type));
  return body.length >= 2 || socketAcceptsKind(flavor, body[0]!.type);
}

/**
 * Does a node of `type` carry the step envelope (`config` / `input` / `parse` / `publish`)? Every leaf
 * step type and `workflow` does; the six controllers (`CONTROLLER_KINDS`, the Graph Controller `goto` included) do not — they are engine
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
      return null; // leaves, `checkpoint`, `goto` and `workflow` nest nothing inline
  }
}
